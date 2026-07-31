import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { sha256Text } from "../../src/core/checksum.js";
import { createEntityId } from "../../src/core/ids.js";
import { inspectWorkspaceState } from "../../src/core/inspect-workspace-state.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { createQaTester, type CanonicalPlanBundleRef } from "../../src/operations/run-workflow.js";
import { sha256Fingerprint } from "../../src/planning/testcase-revision.js";
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

const identities = {
  a: { testCaseId: "TC-REG-A", revisionId: "REV-REG-A", instanceId: "INSTANCE-REG-A" },
  b: { testCaseId: "TC-REG-B", revisionId: "REV-REG-B", instanceId: "INSTANCE-REG-B" },
  outside: { testCaseId: "TC-REG-OUTSIDE", revisionId: "REV-REG-OUTSIDE", instanceId: "INSTANCE-REG-OUTSIDE" },
} as const;

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
async function residualBundle(root: string): Promise<CanonicalPlanBundleRef> {
  const source = await RunWorkspace.create({ root, mode: "plan", environmentProfile: environment });
  const requirement = await source.registerArtifactValue({ type: "requirement-analysis", relationships: [], value: {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-REG",
    statements: [
      { requirementId: "REQ-REG", sourceProvenance: { kind: "user", reference: "phase-8b-task-3" }, normalizedText: "Member must be able to save an email.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] },
    ],
  } });
  const execution = dsl();
  const planCase = (identity: { testCaseId: string; revisionId: string; instanceId: string }, title: string) => ({
    testCaseId: identity.testCaseId, title,
    expectedResults: [{ id: `ER-${identity.testCaseId}`, requirementId: "REQ-REG", authority: "AUTHORITATIVE", text: "Saved" }],
    steps: [{ id: `plan-open-${identity.testCaseId}`, action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [],
    browserExecution: { revisionId: identity.revisionId, instanceId: identity.instanceId, browserDsl: execution, browserDslFingerprint: sha256Fingerprint(execution) },
  });
  const plan = await source.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-REG",
    approvalPolicy: { mode: "auto-approve-safe" },
    testCases: [
      planCase(identities.a, "Save email (selected A)"),
      planCase(identities.b, "Save email (selected B)"),
      planCase(identities.outside, "Save email (outside the selection)"),
    ],
  } });
  const canonicalCase = (identity: { testCaseId: string; revisionId: string; instanceId: string }, title: string, behavior: string, excluded: boolean) => source.registerArtifactValue({ type: "test-case", relationships: [plan.id], value: {
    artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0",
    testCaseId: identity.testCaseId, revisionId: identity.revisionId, instanceId: identity.instanceId,
    title, steps: [{ id: `plan-open-${identity.testCaseId}`, action: "navigate", sideEffect: "none" }],
    coverage: { requirementId: "REQ-REG", role: "member", behavior, browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
    ...(excluded ? { regressionIndex: { requirementIds: [], codeSurfaces: ["outside-surface"], declaredDependencies: [], gitPaths: [], userScope: [] } } : {}),
  } });
  const caseA = await canonicalCase(identities.a, "Save email (selected A)", "save email", false);
  const caseB = await canonicalCase(identities.b, "Save email (selected B)", "save email again", false);
  const caseOutside = await canonicalCase(identities.outside, "Save email (outside the selection)", "save email outside", true);
  const obligation = await source.registerArtifactValue({ type: "coverage-obligation", relationships: [requirement.id], value: {
    artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0",
    obligationId: "COV-REG", requirementAnalysisArtifactId: requirement.id, requirementId: "REQ-REG",
    role: "member", behavior: "save email", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 },
    accessibilityMethod: null, risk: "low", required: true, outcome: "Saved",
  } });
  await source.finalize("plan");
  const records = await Promise.all([requirement, plan, caseA, caseB, caseOutside, obligation].map((artifact) => source.readArtifactRecord(artifact.id)));
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
    evidencePolicies: { required: { safety: { screenshot: "required", console: "required", network: "off", logs: "required" } } },
    changeScopeSources: {
      trusted: {
        changes: [{ id: "CHANGE-REG", requirementIds: ["REQ-REG"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }],
        provenance: { kind: "git-diff", reference: "phase-8b-task-3" },
      },
      unmatched: {
        changes: [{ id: "CHANGE-NONE", requirementIds: ["REQ-NOT-COVERED"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }],
        provenance: { kind: "git-diff", reference: "phase-8b-task-3-empty-selection" },
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
async function registerObservedBatch(root: string, runId: string, observed: readonly { testCaseId: string; revisionId: string; instanceId: string }[]) {
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
      entries: observed.map((identity, index) => ({
        entryId: `ENTRY-${index + 1}`, testCaseId: identity.testCaseId, testCaseRevisionId: identity.revisionId, testCaseInstanceId: identity.instanceId,
        status: "PASSED", failureClassification: "NONE", executionSurface: "api",
        steps: [{ stepId: "observed-open", status: "PASSED", durationMs: 5 }],
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

  it("never lets one case be both driven and observed, which would break the sorted ref comparison", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-residual-disjoint-")); roots.push(root);
    const bundle = await residualBundle(root);
    const tester = regressionTester();
    const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
    await registerObservedBatch(root, paused.runId, [identities.a]);
    await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });

    const artifacts = await registeredArtifacts(root, paused.runId);
    const observedIdentities = artifacts.filter((artifact) => artifact.record.type === "test-result-batch")
      .flatMap((artifact) => (artifact.value.entries as { testCaseId: string; testCaseRevisionId: string; testCaseInstanceId: string }[]).map((entry) => `${entry.testCaseId}:${entry.testCaseRevisionId}:${entry.testCaseInstanceId}`));
    const drivenIdentities = artifacts.filter((artifact) => artifact.record.type === "test-result")
      .map((artifact) => `${String(artifact.value.testCaseId)}:${String(artifact.value.testCaseRevisionId)}:${String(artifact.value.testCaseInstanceId)}`);

    // `sameCheckpointRefs` (src/core/inspect-workspace-state.ts) sorts and compares, so a case counted
    // by BOTH lanes would appear twice on one side of the union and break equality. The residual is what
    // makes that unreachable: the two lanes' identity sets are disjoint by construction.
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
});
