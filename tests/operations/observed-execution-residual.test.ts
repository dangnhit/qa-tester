import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";
import { sha256Text } from "../../src/core/checksum.js";
import { createEntityId } from "../../src/core/ids.js";
import { inspectWorkspaceState } from "../../src/core/inspect-workspace-state.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { createQaTester, type CanonicalPlanBundleRef } from "../../src/operations/run-workflow.js";
import { sha256Fingerprint } from "../../src/planning/testcase-revision.js";
import { TestDataHookRegistry } from "../../src/test-data/hooks.js";
import { serveBrowserFixture } from "../../fixtures/browser/server.js";

/**
 * The residual (Phase 8b Task 3) — a filtered run's selection is ONE filter over TWO lanes, so
 * `execute-browser-test` drives only the selected cases a Runtime-Observed Execution did not already
 * observe, and a selection lane 2 covered entirely leaves nothing to drive.
 *
 * Task 2's pause suite cannot discriminate this: its selection holds ONE case and its batch credits a
 * different, UNSELECTED one, so "drive the whole selection" and "drive the residual" coincide there.
 * Every run here therefore selects TWO cases, with lane 2 covering one or both of them.
 *
 * The invariant these tests bracket from both sides: a run must not reach a valid, finalized state in
 * which a selected case was executed by neither lane. The last two tests are the two directions —
 * covered by either lane is valid, covered by neither invalidates the checkpoint.
 */

const roots: string[] = [];
const environment = {
  artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0",
  environmentProfileId: "ENV-RESIDUAL", name: "Residual fixture", classification: "test",
  baseUrl: "http://127.0.0.1", productionReadOnly: false,
} as const;
const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "../../fixtures/browser/basic.html");
let browser: Browser;
let baseUrl: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  const server = await serveBrowserFixture(fixture);
  baseUrl = server.baseUrl;
  closeServer = () => server.close();
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser.close(); await closeServer(); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function dsl() {
  return { steps: [
    { id: "open", action: { kind: "open", url: baseUrl }, sideEffect: "none" },
    { id: "fill", action: { kind: "fill", locator: { label: "Email" }, value: "qa@example.test" }, assertions: [{ kind: "value", locator: { label: "Email" }, value: "qa@example.test" }], sideEffect: "none" },
    { id: "save", action: { kind: "click", locator: { role: "button", name: "Save" } }, assertions: [{ kind: "text", locator: { testId: "result" }, text: "Saved" }], sideEffect: "none" },
  ] } as const;
}

type Identity = Readonly<{ testCaseId: string; revisionId: string; instanceId: string }>;
type IdentitySet = Readonly<{ a: Identity; b: Identity; outside: Identity }>;

const identities: IdentitySet = {
  a: { testCaseId: "TC-REG-A", revisionId: "REV-REG-A", instanceId: "INSTANCE-REG-A" },
  b: { testCaseId: "TC-REG-B", revisionId: "REV-REG-B", instanceId: "INSTANCE-REG-B" },
  outside: { testCaseId: "TC-REG-OUTSIDE", revisionId: "REV-REG-OUTSIDE", instanceId: "INSTANCE-REG-OUTSIDE" },
};

/**
 * Two SELECTED cases whose identity components a `:`-joined key flattens onto one string, while the nested
 * index keeps them apart: `("TC-COL:X", "REV-COL", "INSTANCE-COL")` and
 * `("TC-COL", "X:REV-COL", "INSTANCE-COL")` both join to `TC-COL:X:REV-COL:INSTANCE-COL`.
 *
 * Every part of this is schema-valid with no tampering. `shared/schemas/test-case.schema.json` gives
 * `testCaseId`, `revisionId` and `instanceId` each `{ "type": "string", "minLength": 1 }` with no
 * `pattern`; `test-result-batch` constrains only `commitSha` and `specTreeSha256`; and `revisionId` is
 * never checked against `sha256Fingerprint`. So a batch crediting ONE of these must not credit the other.
 */
const collidingIdentities: IdentitySet = {
  a: { testCaseId: "TC-COL:X", revisionId: "REV-COL", instanceId: "INSTANCE-COL" },
  b: { testCaseId: "TC-COL", revisionId: "X:REV-COL", instanceId: "INSTANCE-COL" },
  outside: { testCaseId: "TC-COL-OUTSIDE", revisionId: "REV-COL-OUTSIDE", instanceId: "INSTANCE-COL-OUTSIDE" },
};

/** A required manual accessibility obligation, so a run pauses `AWAITING_HUMAN_INPUT` in front of
 *  `generate-qa-report` — the only way to reach a NON-TERMINAL run that has ALREADY driven its cases,
 *  which is where a batch registered after the drive lands. Lifted in shape from `COV-A11Y` in
 *  tests/operations/awaiting-human-input.test.ts. */
const manualAccessibilityObligation = {
  artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0",
  obligationId: "COV-REG-A11Y", requirementId: "REQ-REG",
  role: "member", behavior: "save email with the keyboard alone", executionSurface: "manual",
  accessibilityMethod: "keyboard", risk: "low", required: true, outcome: "Saved",
} as const;

type BundleOptions = Readonly<{ identitySet?: IdentitySet; manualAttestation?: boolean }>;

/**
 * A terminal `plan` run for `regression` mode holding THREE canonical cases in one `auto-approve-safe`
 * plan. `TC-REG-A` and `TC-REG-B` declare no `regressionIndex`, so each one's index falls back to the
 * requirement its `coverage` names and a regression selection over the one declared change keeps BOTH.
 * `TC-REG-OUTSIDE` declares an explicit `regressionIndex` mapping to nothing declared, so the same
 * selection excludes it — a registered identity a Runtime-Observed Execution can legitimately credit
 * while nothing selected it, which is what the intersection at src/core/inspect-workspace-state.ts is
 * for.
 *
 * Same shape as `regressionBundleWithExcludedHumanReviewPlan` in
 * tests/operations/observed-execution-pause.test.ts; the differences are the two SELECTED cases this
 * task's tests need to discriminate whole-selection from residual driving, and one plan rather than two
 * (a `human-review` plan is what that fixture needed for its own excluded case, and an explicit
 * `regressionIndex` excludes this one without an unapproved plan in the way).
 */
async function residualBundle(root: string, options: BundleOptions = {}): Promise<CanonicalPlanBundleRef> {
  const identitySet = options.identitySet ?? identities;
  const source = await RunWorkspace.create({ root, mode: "plan", environmentProfile: environment });
  const requirement = await source.registerArtifactValue({ type: "requirement-analysis", relationships: [], value: {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-REG",
    statements: [
      { requirementId: "REQ-REG", sourceProvenance: { kind: "user", reference: "phase-8b-task-3" }, normalizedText: "Member must be able to save an email.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] },
    ],
  } });
  const execution = dsl();
  const planCase = (identity: Identity, title: string) => ({
    testCaseId: identity.testCaseId, title,
    expectedResults: [{ id: `ER-${identity.testCaseId}`, requirementId: "REQ-REG", authority: "AUTHORITATIVE", text: "Saved" }],
    steps: [{ id: `plan-open-${identity.testCaseId}`, action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [],
    browserExecution: { revisionId: identity.revisionId, instanceId: identity.instanceId, browserDsl: execution, browserDslFingerprint: sha256Fingerprint(execution) },
  });
  const plan = await source.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-REG",
    approvalPolicy: { mode: "auto-approve-safe" },
    testCases: [
      planCase(identitySet.a, "Save email (selected A)"),
      planCase(identitySet.b, "Save email (selected B)"),
      planCase(identitySet.outside, "Save email (outside the selection)"),
    ],
  } });
  const canonicalCase = (identity: Identity, title: string, behavior: string, excluded: boolean) => source.registerArtifactValue({ type: "test-case", relationships: [plan.id], value: {
    artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0",
    testCaseId: identity.testCaseId, revisionId: identity.revisionId, instanceId: identity.instanceId,
    title, steps: [{ id: `plan-open-${identity.testCaseId}`, action: "navigate", sideEffect: "none" }],
    coverage: { requirementId: "REQ-REG", role: "member", behavior, browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
    ...(excluded ? { regressionIndex: { requirementIds: [], codeSurfaces: ["outside-surface"], declaredDependencies: [], gitPaths: [], userScope: [] } } : {}),
  } });
  const caseA = await canonicalCase(identitySet.a, "Save email (selected A)", "save email", false);
  const caseB = await canonicalCase(identitySet.b, "Save email (selected B)", "save email again", false);
  const caseOutside = await canonicalCase(identitySet.outside, "Save email (outside the selection)", "save email outside", true);
  const obligation = await source.registerArtifactValue({ type: "coverage-obligation", relationships: [requirement.id], value: {
    artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0",
    obligationId: "COV-REG", requirementAnalysisArtifactId: requirement.id, requirementId: "REQ-REG",
    role: "member", behavior: "save email", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 },
    accessibilityMethod: null, risk: "low", required: true, outcome: "Saved",
  } });
  const attestable = options.manualAttestation !== true ? [] : [await source.registerArtifactValue({
    type: "coverage-obligation", relationships: [requirement.id],
    value: { ...manualAccessibilityObligation, requirementAnalysisArtifactId: requirement.id },
  })];
  await source.finalize("plan");
  const records = await Promise.all([requirement, plan, caseA, caseB, caseOutside, obligation, ...attestable].map((artifact) => source.readArtifactRecord(artifact.id)));
  await source.close();
  return { sourceRunId: source.runId, artifacts: records.map((artifact) => ({ artifactId: artifact.id, sha256: artifact.sha256 })) };
}

/**
 * Two declared change scopes on one tester: `trusted` names the requirement both selected cases cover,
 * and `unmatched` names a requirement nothing covers, which is how the last test reaches a run whose
 * selection is empty without inventing a second bundle.
 */
function regressionTester() {
  return createQaTester({
    browserManagers: { chromium: { browser } },
    // `full` mode is the only one that needs this (`missingRuntimeLabel` in
    // src/operations/run-workflow.ts); the ungated-residual tests below run in that mode.
    testDataRegistries: { trusted: new TestDataHookRegistry([], {}) },
    evidencePolicies: { required: { safety: { screenshot: "required", console: "required", network: "off", logs: "required" } } },
    changeScopeSources: {
      trusted: {
        changes: [{ id: "CHANGE-REG", requirementIds: ["REQ-REG"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }],
        provenance: { kind: "git-diff", reference: "phase-8b-task-3" },
      },
      unmatched: {
        changes: [{ id: "CHANGE-NONE", requirementIds: ["REQ-NOT-COVERED"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }],
        // Deliberately omits the task number, and this comment deliberately does not quote the string it
        // is about. `scripts/check-secrets.ts` reads an OpenAI-style provider key as the last two letters
        // of "task" followed by a long hyphenated tail, so spelling the obvious reference here — task
        // number, then "-empty-selection" — trips the scan in the reference AND in any comment quoting
        // it. The scan walks git-TRACKED files, so it stays invisible until the file is committed.
        provenance: { kind: "git-diff", reference: "phase-8b-empty-selection" },
      },
    },
  });
}

function regressionInput(root: string, bundle: CanonicalPlanBundleRef, changeScopeSourceId: "trusted" | "unmatched" = "trusted") {
  return {
    root, mode: "regression" as const, environmentProfile: environment, bundle,
    runtime: { browserManagerId: "chromium", evidencePolicyId: "required", changeScopeSourceId },
  };
}

/** `execute` and `full` reach the residual too — `ensureCanonicalBundle`'s generic fallback fills
 *  `executionCaseIds` from every imported `test-case` — so they select ALL THREE cases, including the one
 *  a `regression` selection excludes. Neither mode runs `select-regression`, so neither takes a change
 *  scope. */
function ungatedModeInput(root: string, bundle: CanonicalPlanBundleRef, mode: "execute" | "full") {
  return {
    root, mode, environmentProfile: environment, bundle,
    runtime: { browserManagerId: "chromium", evidencePolicyId: "required", testDataRegistryId: "trusted" },
  };
}

/** The `qa-skill attestation record` that clears an `AWAITING_HUMAN_INPUT` pause on
 *  `manualAccessibilityObligation`, so a post-drive pause can be shown to still be RESUMABLE rather than
 *  merely readable. */
async function recordAttestation(root: string, runId: string) {
  const recorded = await runCli([
    "attestation", "record", "--root", root, "--run-id", runId,
    "--obligation-id", "COV-REG-A11Y", "--method", "keyboard", "--attested-by", "reviewer@example.test",
    "--statement", "Completed the save-email flow with the keyboard alone; every control was reachable and focus stayed visible.",
  ], { cwd: root });
  expect(recorded.stderr).toBe("");
  expect(recorded.exitCode).toBe(ExitCode.SUCCESS);
}

/** The checkpoint-chain refusal, which is what a broken union comparison surfaces as. */
const checkpointChainDiagnostic = "Workflow checkpoints must form an immutable revision chain with verified operation outputs";

async function workspaceDiagnostics(root: string, runId: string): Promise<readonly string[]> {
  const inspected = await inspectWorkspaceState(join(root, "qa-results", runId), runId, (crossRoot, crossRunId) => RunWorkspace.open(crossRoot, crossRunId));
  return inspected.diagnostics.map((diagnostic) => diagnostic.message);
}

/** Lifted from tests/operations/observed-execution-pause.test.ts. */
async function registeredArtifacts(root: string, runId: string) {
  const workspace = await RunWorkspace.open(root, runId);
  try { return await workspace.readRegisteredArtifacts(); } finally { await workspace.close(); }
}

async function drivenCaseIds(root: string, runId: string): Promise<readonly string[]> {
  return (await registeredArtifacts(root, runId)).filter((artifact) => artifact.record.type === "test-result").map((artifact) => String(artifact.value.testCaseId)).sort();
}

/** Lifted verbatim from tests/orchestration/runtime-public.e2e.test.ts. Only a payload is rewritten
 *  below — never a checkpoint's own `state` — so no `stateChecksum` has to be recomputed with it. */
async function rechecksumRegisteredArtifact(workspace: RunWorkspace, artifactId: string, mutate: (value: Record<string, unknown>) => void): Promise<void> {
  const record = await workspace.readArtifactRecord(artifactId);
  const artifactPath = await workspace.resolve(record.relativePath);
  const value = JSON.parse(await readFile(artifactPath, "utf8")) as Record<string, unknown>;
  mutate(value);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(artifactPath, contents);
  const manifestPath = join(workspace.path, "artifact-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; sha256: string }[] };
  const manifestRecord = manifest.artifacts.find((item) => item.id === artifactId);
  if (!manifestRecord) throw new Error("Expected manifest artifact");
  manifestRecord.sha256 = sha256Text(contents);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Registers a lane-2 Runtime-Observed Execution into an open (paused) run, without running Playwright.
 *
 * Extends `registerObservedBatch` in tests/operations/observed-execution-pause.test.ts in two ways, both
 * forced by what this task's runs reach that the pause never did.
 *
 * First it takes SEVERAL identities, because a batch is per-execution and holds many entries: the
 * whole-selection test needs one execution covering both selected cases, and the neither-lane test needs
 * a batch whose relationships already declare an unselected case so that rewriting an entry's identity
 * onto it leaves the batch's OWN rule (`testResultBatchRule`, src/core/semantic-rules.ts) satisfied —
 * otherwise the run would be refused as an orphan entry and the checkpoint check under test would never
 * be reached.
 *
 * Second it registers the `observed-execution` evidence the real producer always registers before the
 * batch (src/operations/execute-observed-playwright.ts), because a run lane 2 covered ENTIRELY drives
 * nothing and therefore captures no lane-1 evidence — and `collect-evidence`'s postcondition
 * (src/operations/run-workflow.ts) requires the operation to return at least one evidence or evidence
 * gap. Task 2's helper could omit it only because every run there still drove a case.
 *
 * Like that helper it credits ALREADY-REGISTERED cases and throws otherwise: `mapObservedReport`
 * (src/observed/report-mapping.ts) excludes an unmatched spec rather than inventing a case, and
 * `regressionSelectionRule` (src/core/semantic-rules.ts) re-derives the selection over every registered
 * `test-case` on the next open, so growing the pool would invalidate a selection nothing else touched.
 */
async function registerObservedBatch(root: string, runId: string, observed: readonly (Identity & { status?: "PASSED" | "FAILED" | "NOT_RUN" | "BLOCKED" | "INCONCLUSIVE" })[]) {
  const workspace = await RunWorkspace.open(root, runId);
  try {
    const registered = await workspace.readRegisteredArtifacts();
    const cases = observed.map((identity) => {
      const testCase = registered.find((artifact) => artifact.record.type === "test-case"
        && artifact.value.testCaseId === identity.testCaseId && artifact.value.revisionId === identity.revisionId && artifact.value.instanceId === identity.instanceId);
      if (!testCase) throw new Error(`Expected an already-registered test-case for ${identity.testCaseId}/${identity.revisionId}/${identity.instanceId}`);
      return testCase;
    });
    const executionId = createEntityId();
    const evidenceId = createEntityId();
    const payload = `${JSON.stringify({ suites: [], config: {} }, null, 2)}\n`;
    const bundle = await workspace.registerEvidenceBundle({
      binaries: [{ filename: `${evidenceId}-sanitized-runner-report.json`, contents: Buffer.from(payload, "utf8"), mediaType: "application/json", captureType: "runner-report" }],
      relationships: [], provenance: "runtime",
      descriptor: (binaries) => {
        const binary = binaries[0];
        if (binary === undefined) throw new Error("Expected a registered runner-report binary");
        return {
          artifactType: "evidence", schemaVersion: "3.0.0", producerVersion: "1.0.0",
          evidenceId, runId, subject: { kind: "observed-execution", executionId },
          kind: "runner-report", capturedAt: "2026-07-31T00:00:01.000Z",
          sha256: binary.sha256, relativePath: binary.relativePath, mediaType: binary.mediaType,
          binaryArtifactIds: [binary.id],
          binaryArtifacts: [{ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType }],
          provenance: { captureType: "runner-report", runner: "playwright", runnerVersion: "1.0.0", exitCode: 0, capturedAt: "2026-07-31T00:00:01.000Z" },
        };
      },
    });
    return await workspace.registerArtifactValue({ type: "test-result-batch", provenance: "runtime-observed", relationships: [bundle.descriptor.id, ...cases.map((artifact) => artifact.record.id)], value: {
      artifactType: "test-result-batch", schemaVersion: "3.0.0", producerVersion: "1.0.0",
      executionId, runId, commitSha: "0".repeat(40), specTreeSha256: "1".repeat(64),
      startedAt: "2026-07-31T00:00:00.000Z", finishedAt: "2026-07-31T00:00:01.000Z",
      // `failureClassification` follows the status the way `mapObservedReport` derives it: `PASSED` pairs
      // with `NONE`, everything else with `UNDETERMINED`, which is the biconditional `testResultBatchRule`
      // enforces. A test that varied the status alone would be refused by that rule, not by the code
      // under test.
      entries: observed.map((identity, index) => ({
        entryId: `ENTRY-${index + 1}`, testCaseId: identity.testCaseId, testCaseRevisionId: identity.revisionId, testCaseInstanceId: identity.instanceId,
        status: identity.status ?? "PASSED", failureClassification: (identity.status ?? "PASSED") === "PASSED" ? "NONE" : "UNDETERMINED", executionSurface: "api",
        steps: [{ stepId: "observed-open", status: identity.status ?? "PASSED", durationMs: 5 }],
      })),
    } });
  } finally { await workspace.close(); }
}

describe("the residual: one selection, two lanes", () => {
  it("drives only the selected cases lane 2 did not observe", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-partial-")); roots.push(root);
    const bundle = await residualBundle(root);
    const tester = regressionTester();
    const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
    expect(paused.outcome).toBe("AWAITING_OBSERVED_EXECUTION");
    await registerObservedBatch(root, paused.runId, [identities.a]);

    const resumed = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });

    // Consequence, not just the outcome string: exactly one attempt exists and it is the case lane 2
    // did NOT observe. The selection held both.
    expect(await drivenCaseIds(root, paused.runId)).toEqual(["TC-REG-B"]);
    expect(resumed.outcome).toBe("COMPLETED");
    expect(resumed.validation.valid).toBe(true);
  }, 180_000);

  it("completes with zero driven attempts when lane 2 observed the whole selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-whole-")); roots.push(root);
    const bundle = await residualBundle(root);
    const tester = regressionTester();
    const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
    await registerObservedBatch(root, paused.runId, [identities.a, identities.b]);

    const resumed = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });

    expect(await drivenCaseIds(root, paused.runId)).toEqual([]);
    expect(resumed.outcome).toBe("COMPLETED");
    expect(resumed.validation.valid).toBe(true);
    // The consequence a `validation.valid` assertion alone hides, asserted rather than implied: every entry
    // this suite registers declares `executionSurface: "api"` while `COV-REG` is a `browser` obligation, so
    // an api suite that cancels a browser obligation's execution leaves it UNMET. Valid is not the same as
    // covered, and the run says so — the honesty rule this whole mechanism rests on.
    expect(resumed.releaseRecommendation).toBe("NOT_READY");
    const gate = (await registeredArtifacts(root, paused.runId)).find((artifact) => artifact.record.type === "release-gate");
    const ruleInputs = gate?.value.ruleInputs as { coverage: { requiredMissing: string[] } };
    expect(ruleInputs.coverage.requiredMissing).toEqual(["COV-REG"]);
  }, 180_000);

  it("still refuses a run with no cases and no observed execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-refusal-")); roots.push(root);
    const bundle = await residualBundle(root);

    // No `observedExecution`, and a declared change scope that selects nothing: the original refusal's
    // own state — nothing to execute and nothing observed either.
    await expect(regressionTester()(regressionInput(root, bundle, "unmatched")))
      .rejects.toThrow("Runtime execution requires imported approved canonical test cases");
  }, 180_000);

  it("keeps a run valid when lane 2 observed a case outside the selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-outside-")); roots.push(root);
    const bundle = await residualBundle(root);
    const tester = regressionTester();
    const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
    await registerObservedBatch(root, paused.runId, [identities.outside]);

    const resumed = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });

    // A lane-2 suite that ran EXTRA tagged specs neither shrinks what is driven nor widens what the
    // checkpoint may claim: both selected cases are driven, and the observed case outside the selection
    // contributes nothing to the coverage comparison.
    expect(await drivenCaseIds(root, paused.runId)).toEqual(["TC-REG-A", "TC-REG-B"]);
    expect(resumed.outcome).toBe("COMPLETED");
    expect(resumed.validation.valid).toBe(true);
  }, 180_000);

  it("leaves the two lanes disjoint when the batch precedes the drive, because the residual subtracts first", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-disjoint-")); roots.push(root);
    const bundle = await residualBundle(root);
    const tester = regressionTester();
    const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
    await registerObservedBatch(root, paused.runId, [identities.a]);
    await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });

    const artifacts = await registeredArtifacts(root, paused.runId);
    const observedIdentities = artifacts.filter((artifact) => artifact.record.type === "test-result-batch")
      .flatMap((artifact) => (artifact.value.entries as { testCaseId: string; testCaseRevisionId: string; testCaseInstanceId: string }[]).map((entry) => JSON.stringify([entry.testCaseId, entry.testCaseRevisionId, entry.testCaseInstanceId])));
    const drivenIdentities = artifacts.filter((artifact) => artifact.record.type === "test-result")
      .map((artifact) => JSON.stringify([String(artifact.value.testCaseId), String(artifact.value.testCaseRevisionId), String(artifact.value.testCaseInstanceId)]));

    // Disjointness is a property of THIS ORDER — one invocation in which the batch is already registered
    // when the residual is computed — and NOT a property the checkpoint check may rely on: a batch can
    // arrive after the drive, from an `execute playwright` against any non-terminal run. What
    // `inspectWorkspaceState` ENFORCES is that every selected case is named by at least one lane, over
    // SETS, so an overlap is legal and inert; "keeps a run readable when one case is both driven and
    // observed" below is the test for that direction. This one pins only that the residual really does
    // subtract before it drives, which is what makes a redundant second execution unreachable.
    expect(observedIdentities).not.toHaveLength(0);
    expect(drivenIdentities).not.toHaveLength(0);
    expect(drivenIdentities.filter((identity) => observedIdentities.includes(identity))).toEqual([]);
  }, 180_000);

  it("invalidates a checkpoint whose selected case was covered by neither lane", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-neither-")); roots.push(root);
    const bundle = await residualBundle(root);
    const tester = regressionTester();
    const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
    // The batch declares BOTH cases as relationships and credits A, so residual driving covers B. The
    // rewrite below then moves A's entry onto the already-declared unselected identity, which keeps the
    // batch's own rule satisfied — the only thing that changes is that nothing covers A any more.
    await registerObservedBatch(root, paused.runId, [identities.a, identities.outside]);
    const resumed = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });
    expect(resumed.validation.valid).toBe(true);
    expect(await drivenCaseIds(root, paused.runId)).toEqual(["TC-REG-B"]);

    const workspace = await RunWorkspace.open(root, paused.runId);
    const batch = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "test-result-batch");
    if (!batch) throw new Error("Expected an observed batch");
    await rechecksumRegisteredArtifact(workspace, batch.record.id, (value) => {
      const entries = value.entries as Record<string, unknown>[];
      const entry = entries[0];
      if (!entry || entry.testCaseId !== identities.a.testCaseId) throw new Error("Expected the first entry to credit the selected case");
      entry.testCaseId = identities.outside.testCaseId;
      entry.testCaseRevisionId = identities.outside.revisionId;
      entry.testCaseInstanceId = identities.outside.instanceId;
    });
    await workspace.close();

    // Asserted on the FULL diagnostic list rather than on the thrown message, because `RunWorkspace.open`
    // surfaces only `diagnostics[0]` and a batch whose entries moved also stops matching the immutable
    // `release-gate` derived from them — so the message alone would not say WHICH check refused, and a
    // broad regex would pass with the union comparison removed entirely.
    const inspected = await inspectWorkspaceState(join(root, "qa-results", paused.runId), paused.runId, (crossRoot, crossRunId) => RunWorkspace.open(crossRoot, crossRunId));
    expect(inspected.diagnostics.map((diagnostic) => diagnostic.message)).toContain("Workflow checkpoints must form an immutable revision chain with verified operation outputs");
    await expect(RunWorkspace.open(root, paused.runId)).rejects.toThrow(/Workspace artifact binding is invalid/);
  }, 180_000);

  it("drives the case an observed entry reports NOT_RUN for, and not the one beside it that ran", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-not-run-")); roots.push(root);
    const bundle = await residualBundle(root);
    const tester = regressionTester();
    const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
    // What a tagged spec that `test.skip`s produces: `mapObservedReport` maps `skipped` to NOT_RUN,
    // "nothing executed". The batch is stamped `runtime-observed` and satisfies every clause of
    // `testResultBatchRule` — the evidence clause only fires on a PASSED entry — so nothing upstream
    // refuses it. One execution, two entries, opposite consequences: the skipped one must not stop lane 1
    // driving its case, and the one that ran must.
    await registerObservedBatch(root, paused.runId, [{ ...identities.a, status: "NOT_RUN" }, identities.b]);

    const resumed = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });

    expect(await drivenCaseIds(root, paused.runId)).toEqual(["TC-REG-A"]);
    expect(resumed.outcome).toBe("COMPLETED");
    expect(resumed.validation.valid).toBe(true);
  }, 180_000);

  it("keeps waiting for lane 2 when every observed entry reports NOT_RUN", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-not-run-only-")); roots.push(root);
    const bundle = await residualBundle(root);
    const tester = regressionTester();
    const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
    await registerObservedBatch(root, paused.runId, [{ ...identities.a, status: "NOT_RUN" }]);

    const resumed = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });

    // A suite in which every tagged spec skipped observed nothing, so the run is exactly where it was
    // before it ran and says so — the same ruling `pendingObservedExecution` (src/operations/observed-pause.ts)
    // already applies to a batch that failed its semantic rule, reached through the one shared reader.
    // The safe direction either way: nothing is executed by neither lane, because nothing finalizes.
    expect(resumed.outcome).toBe("AWAITING_OBSERVED_EXECUTION");
    const artifacts = await registeredArtifacts(root, paused.runId);
    expect(artifacts.filter((artifact) => artifact.record.type === "test-result")).toHaveLength(0);
    expect(artifacts.some((artifact) => artifact.record.type === "release-gate")).toBe(false);
  }, 180_000);

  it("invalidates a checkpoint whose selected case is claimed only by a NOT_RUN entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-not-run-union-")); roots.push(root);
    const bundle = await residualBundle(root);
    const tester = regressionTester();
    const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
    await registerObservedBatch(root, paused.runId, [identities.a]);
    const resumed = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });
    expect(resumed.validation.valid).toBe(true);
    expect(await drivenCaseIds(root, paused.runId)).toEqual(["TC-REG-B"]);

    // The union side of the same question, reached through the STATUS rather than the identity: A keeps
    // its entry and its identity, and only its outcome changes to the one that means nothing executed.
    // `failureClassification` moves with it because `testResultBatchRule` enforces the biconditional, so
    // the batch stays valid and the checkpoint is the only thing that can refuse.
    const workspace = await RunWorkspace.open(root, paused.runId);
    const batch = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "test-result-batch");
    if (!batch) throw new Error("Expected an observed batch");
    await rechecksumRegisteredArtifact(workspace, batch.record.id, (value) => {
      const entry = (value.entries as Record<string, unknown>[])[0];
      if (!entry || entry.testCaseId !== identities.a.testCaseId) throw new Error("Expected the first entry to credit the selected case");
      entry.status = "NOT_RUN";
      entry.failureClassification = "UNDETERMINED";
    });
    await workspace.close();

    const inspected = await inspectWorkspaceState(join(root, "qa-results", paused.runId), paused.runId, (crossRoot, crossRunId) => RunWorkspace.open(crossRoot, crossRunId));
    expect(inspected.diagnostics.map((diagnostic) => diagnostic.message)).toContain("Workflow checkpoints must form an immutable revision chain with verified operation outputs");
    await expect(RunWorkspace.open(root, paused.runId)).rejects.toThrow(/Workspace artifact binding is invalid/);
  }, 180_000);

  it("waits for the browser manager even when lane 2 covered the whole selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-no-runtime-")); roots.push(root);
    const bundle = await residualBundle(root);
    const paused = await regressionTester()({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
    await registerObservedBatch(root, paused.runId, [identities.a, identities.b]);

    // Resumed against a registry holding no browser manager. `missingRuntimeLabel` is evaluated BEFORE the
    // operation loop, so a run that would drive nothing at all still stops at AWAITING_RUNTIME. Pinned
    // because it is the reason a `return []` short-circuit in front of `executeWithRuntime` buys nothing
    // (no well-formed run reaches that call with an unresolvable manager), and because relaxing it for a
    // lane-2-only run is a live question for the CLI modes rather than something to change here silently.
    const resumed = await createQaTester({})({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });

    expect(resumed.outcome).toBe("AWAITING_RUNTIME");
    expect(await drivenCaseIds(root, paused.runId)).toEqual([]);
  }, 180_000);

  /**
   * The identity is matched COMPONENT BY COMPONENT, never as a `:`-joined string. `collidingIdentities.a`
   * and `.b` are two distinct schema-valid canonical cases that join to one string, so a joined key let a
   * batch crediting `a` also credit `b`: the residual emptied, lane 1 drove nothing, the checkpoint's union
   * counted the case anyway, and the run finalized COMPLETED with `validation.valid` true — a case in
   * `state.executionCases` executed by NEITHER lane, with no tampering at all. See `caseIdentity` in
   * src/core/observed-coverage.ts.
   *
   * Only `b` is in the selection, and that is a SECOND, pre-existing collision this test does not fix:
   * `selectRegressionCases` (src/regression/selector.ts, unchanged since long before this branch) keys its
   * own decision map on the same join, so the two cases collapse to one decision and `b` — the later
   * insertion — wins. That makes `b` the selected case whose execution a credit of `a` must not cancel,
   * which is what this asserts.
   */
  it("credits only the case a batch entry names, not another whose components rejoin to the same string", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-collide-")); roots.push(root);
    const bundle = await residualBundle(root, { identitySet: collidingIdentities });
    const tester = regressionTester();
    const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
    expect(paused.outcome).toBe("AWAITING_OBSERVED_EXECUTION");
    await registerObservedBatch(root, paused.runId, [collidingIdentities.a]);

    const resumed = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });

    // The residual still holds `b`, whose identity differs from the credited one only in WHERE the colon
    // falls. A joined key leaves this EMPTY, with nothing driven and the run still valid.
    expect(await drivenCaseIds(root, paused.runId)).toEqual([collidingIdentities.b.testCaseId]);
    expect(resumed.outcome).toBe("COMPLETED");
    expect(resumed.validation.valid).toBe(true);
  }, 180_000);

  /**
   * The overlap the union comparison must survive, reached exactly the way the whole-branch review
   * constructed it and with no tampering: a run that has ALREADY driven its selection but is still
   * NON-TERMINAL, because a required manual accessibility obligation pauses it in front of
   * `generate-qa-report`. `qa-skill execute playwright` opens any non-terminal run, asks nothing about what
   * has been driven, registers a batch and exits 0 — so a case named by BOTH lanes is a legal state.
   *
   * Fed to a MULTISET comparison that made the union longer than the duplicate-free
   * `state.executionCases`, it invalidated the checkpoint forever: no `open`, resume, attestation,
   * finalize, validation or export could read the run again, and there is no abort command. Every
   * assertion below is a step of that recovery, in order.
   */
  it("keeps a run readable when one case is both driven and observed", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-both-lanes-")); roots.push(root);
    const bundle = await residualBundle(root, { manualAttestation: true });
    const tester = regressionTester();

    // No `observedExecution`: this run drives its whole selection, then stops for a person.
    const paused = await tester(regressionInput(root, bundle));
    expect(paused.outcome).toBe("AWAITING_HUMAN_INPUT");
    expect(await drivenCaseIds(root, paused.runId)).toEqual(["TC-REG-A", "TC-REG-B"]);

    await registerObservedBatch(root, paused.runId, [identities.a]);

    expect(await workspaceDiagnostics(root, paused.runId)).not.toContain(checkpointChainDiagnostic);
    await recordAttestation(root, paused.runId);
    const resumed = await tester({ ...regressionInput(root, bundle), resumeRunId: paused.runId });

    expect(resumed.outcome).toBe("COMPLETED");
    expect(resumed.validation.valid).toBe(true);
    // Rehydrated, not re-driven: the overlap is one true fact stated twice, not a second execution.
    expect(await drivenCaseIds(root, paused.runId)).toEqual(["TC-REG-A", "TC-REG-B"]);
  }, 180_000);

  /**
   * The same batch-after-drive arrival in `full` mode, which is where it regressed a capability this
   * branch never meant to touch: `skills/shared/references/observed-execution.md` documents `execute` and
   * `full` accepting a `test-result-batch` wherever they accept a `test-result`, and neither mode has any
   * `observedExecution` field or residual of its own. `git show e8d172d:src/core/inspect-workspace-state.ts`
   * compared against the driven refs alone, so this was safe before the branch.
   */
  it("keeps a full run readable when a batch arrives after the drive", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-full-batch-")); roots.push(root);
    const bundle = await residualBundle(root, { manualAttestation: true });
    const tester = regressionTester();

    const paused = await tester(ungatedModeInput(root, bundle, "full"));
    expect(paused.outcome).toBe("AWAITING_HUMAN_INPUT");
    // `full` drives every imported case, including the one a regression selection would exclude.
    expect(await drivenCaseIds(root, paused.runId)).toEqual(["TC-REG-A", "TC-REG-B", "TC-REG-OUTSIDE"]);

    await registerObservedBatch(root, paused.runId, [identities.a]);

    expect(await workspaceDiagnostics(root, paused.runId)).not.toContain(checkpointChainDiagnostic);
    await recordAttestation(root, paused.runId);
    const resumed = await tester({ ...ungatedModeInput(root, bundle, "full"), resumeRunId: paused.runId });

    expect(resumed.outcome).toBe("COMPLETED");
    expect(resumed.validation.valid).toBe(true);
  }, 180_000);

  /**
   * The residual is a `regression` mechanism (Phase 8b human ruling 2). `execute` reaches the same line —
   * `ensureCanonicalBundle`'s generic fallback fills its `executionCaseIds` — and accepts a batch as an
   * execution record, but never narrows what it drives, so an observed entry must NOT cancel one of its
   * executions. Ungated, this run drove two cases instead of three and nothing said so.
   */
  it("subtracts nothing in execute mode, which has no residual of its own", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-execute-")); roots.push(root);
    const bundle = await residualBundle(root);
    const tester = regressionTester();
    const paused = await tester({ ...ungatedModeInput(root, bundle, "execute"), observedExecution: { expected: true } });
    // The pause itself is mode-agnostic — it gates on the OPERATION, not on the mode — so `execute` can
    // arm it. What follows is about what the resume then DRIVES.
    expect(paused.outcome).toBe("AWAITING_OBSERVED_EXECUTION");
    await registerObservedBatch(root, paused.runId, [identities.a]);

    const resumed = await tester({ ...ungatedModeInput(root, bundle, "execute"), observedExecution: { expected: true }, resumeRunId: paused.runId });

    expect(await drivenCaseIds(root, paused.runId)).toEqual(["TC-REG-A", "TC-REG-B", "TC-REG-OUTSIDE"]);
    expect(resumed.outcome).toBe("COMPLETED");
    expect(resumed.validation.valid).toBe(true);
  }, 180_000);

  /**
   * A lane-2 `FAILED` entry is an OBSERVED FAILURE, and a run holding one must not report success.
   * `hasExecutionFailures` (src/operations/run-workflow.ts) read only `test-result`, so with the whole
   * selection observed and one entry FAILED the run finalized `COMPLETED` with `validation.valid` true —
   * where pre-branch the same case would have been driven, failed, and exited 1.
   *
   * The bug disposition is a separate question this deliberately does NOT assert as present: a batch entry
   * carries `entryId`, never `attemptId`, so `generateBugReport` has nothing to bind a defect to. That
   * limit is documented rather than papered over — see `assertFailureDispositionPostcondition`.
   */
  it("reports failure when lane 2 observed a FAILED entry, with no lane-1 attempt at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-observed-failure-")); roots.push(root);
    const bundle = await residualBundle(root);
    const tester = regressionTester();
    const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
    await registerObservedBatch(root, paused.runId, [{ ...identities.a, status: "FAILED" }, identities.b]);

    const resumed = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });

    expect(await drivenCaseIds(root, paused.runId)).toEqual([]);
    expect(resumed.outcome).toBe("COMPLETED_WITH_FAILURES");
    expect(resumed.validation.valid).toBe(true);
    const artifacts = await registeredArtifacts(root, paused.runId);
    expect(artifacts.some((artifact) => artifact.record.type === "bug-report")).toBe(false);
    const metadata = JSON.parse(await readFile(join(root, "qa-results", paused.runId, "run-metadata.json"), "utf8")) as { status: string };
    expect(metadata.status).toBe("COMPLETED_WITH_FAILURES");
  }, 180_000);
});
