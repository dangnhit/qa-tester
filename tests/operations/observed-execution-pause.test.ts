import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { RunWorkspace } from "../../src/core/run-workspace.js";
import { createQaTester, type CanonicalPlanBundleRef } from "../../src/operations/run-workflow.js";
import { sha256Fingerprint } from "../../src/planning/testcase-revision.js";
import { serveBrowserFixture } from "../../fixtures/browser/server.js";

/**
 * `AWAITING_OBSERVED_EXECUTION` (Phase 8b Task 2) — the run stops in front of `execute-browser-test`
 * while it still expects a Runtime-Observed Execution (`qa-skill execute playwright`) to supply part
 * of its execution, and resumes once that command has registered a `test-result-batch` into the run.
 *
 * This task does not narrow what a resume drives: once the pause clears, a resume drives the whole
 * selection, same as today. Task 3 adds the residual.
 */

const roots: string[] = [];
const environment = {
  artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0",
  environmentProfileId: "ENV-HUMAN", name: "Human input fixture", classification: "test",
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

/**
 * A terminal `plan` run for `regression` mode: two independent plans sharing one requirement, each
 * holding one canonical test case. `PLAN-REG-INCLUDED` is `auto-approve-safe`; its case declares no
 * `regressionIndex`, so its index falls back to the requirement its `coverage` names (matching the one
 * declared change) and a regression selection keeps it. `PLAN-REG-EXCLUDED` is `human-review` and
 * unapproved; its case declares an explicit `regressionIndex` that maps to nothing declared, so the
 * same selection excludes it even though both cases cover the same requirement.
 *
 * Lifted verbatim from tests/operations/awaiting-human-input.test.ts — this task's tests need an
 * ALREADY-registered, non-selected identity to register a lane-2 batch against (see
 * `registerObservedBatch` below), which the single-case `planBundle` in that file cannot provide.
 */
async function regressionBundleWithExcludedHumanReviewPlan(root: string): Promise<CanonicalPlanBundleRef> {
  const source = await RunWorkspace.create({ root, mode: "plan", environmentProfile: environment });
  const requirement = await source.registerArtifactValue({ type: "requirement-analysis", relationships: [], value: {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-REG",
    statements: [
      { requirementId: "REQ-REG", sourceProvenance: { kind: "user", reference: "task-37-finding-5" }, normalizedText: "Member must be able to save an email.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] },
    ],
  } });
  const execution = dsl();
  const includedPlan = await source.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-REG-INCLUDED",
    approvalPolicy: { mode: "auto-approve-safe" },
    testCases: [{
      testCaseId: "TC-REG-INCLUDED", title: "Save email (selected by regression)",
      expectedResults: [{ id: "ER-REG-INCLUDED", requirementId: "REQ-REG", authority: "AUTHORITATIVE", text: "Saved" }],
      steps: [{ id: "plan-open-included", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [],
      browserExecution: { revisionId: "REV-REG-INCLUDED", instanceId: "INSTANCE-REG-INCLUDED", browserDsl: execution, browserDslFingerprint: sha256Fingerprint(execution) },
    }],
  } });
  const excludedPlan = await source.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-REG-EXCLUDED",
    approvalPolicy: { mode: "human-review" },
    testCases: [{
      testCaseId: "TC-REG-EXCLUDED", title: "Save email (excluded by regression)",
      expectedResults: [{ id: "ER-REG-EXCLUDED", requirementId: "REQ-REG", authority: "AUTHORITATIVE", text: "Saved" }],
      steps: [{ id: "plan-open-excluded", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [],
      browserExecution: { revisionId: "REV-REG-EXCLUDED", instanceId: "INSTANCE-REG-EXCLUDED", browserDsl: execution, browserDslFingerprint: sha256Fingerprint(execution) },
    }],
  } });
  const includedCase = await source.registerArtifactValue({ type: "test-case", relationships: [includedPlan.id], value: {
    artifactType: "test-case", schemaVersion: "3.0.0", producerVersion: "1.0.0", testCaseId: "TC-REG-INCLUDED", revisionId: "REV-REG-INCLUDED", instanceId: "INSTANCE-REG-INCLUDED",
    title: "Save email (selected by regression)", steps: [{ id: "plan-open-included", action: "navigate", sideEffect: "none" }],
    coverage: { requirementId: "REQ-REG", role: "member", behavior: "save email", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
  } });
  const excludedCase = await source.registerArtifactValue({ type: "test-case", relationships: [excludedPlan.id], value: {
    artifactType: "test-case", schemaVersion: "3.0.0", producerVersion: "1.0.0", testCaseId: "TC-REG-EXCLUDED", revisionId: "REV-REG-EXCLUDED", instanceId: "INSTANCE-REG-EXCLUDED",
    title: "Save email (excluded by regression)", steps: [{ id: "plan-open-excluded", action: "navigate", sideEffect: "none" }],
    coverage: { requirementId: "REQ-REG", role: "member", behavior: "save email, excluded", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
    regressionIndex: { requirementIds: [], codeSurfaces: ["excluded-surface"], declaredDependencies: [], gitPaths: [], userScope: [] },
  } });
  const obligation = await source.registerArtifactValue({ type: "coverage-obligation", relationships: [requirement.id], value: {
    artifactType: "coverage-obligation", schemaVersion: "4.0.0", producerVersion: "1.0.0",
    obligationId: "COV-REG", requirementAnalysisArtifactId: requirement.id, requirementId: "REQ-REG",
    role: "member", behavior: "save email", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 },
    accessibilityMethod: null, risk: "low", required: true, outcome: "Saved",
  } });
  await source.finalize("plan");
  const records = await Promise.all([requirement, includedPlan, excludedPlan, includedCase, excludedCase, obligation].map((artifact) => source.readArtifactRecord(artifact.id)));
  await source.close();
  return { sourceRunId: source.runId, artifacts: records.map((artifact) => ({ artifactId: artifact.id, sha256: artifact.sha256 })) };
}

/** Lifted verbatim from tests/operations/awaiting-human-input.test.ts. */
function regressionTester() {
  return createQaTester({
    browserManagers: { chromium: { browser } },
    evidencePolicies: { required: { safety: { screenshot: "required", console: "required", network: "off", logs: "required" } } },
    changeScopeSources: { trusted: {
      changes: [{ id: "CHANGE-REG-INCLUDED", requirementIds: ["REQ-REG"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }],
      provenance: { kind: "git-diff", reference: "task-37-finding-5" },
    } },
  });
}

/** Lifted verbatim from tests/operations/awaiting-human-input.test.ts. */
function regressionInput(root: string, bundle: CanonicalPlanBundleRef) {
  return {
    root, mode: "regression" as const, environmentProfile: environment, bundle,
    runtime: { browserManagerId: "chromium", evidencePolicyId: "required", changeScopeSourceId: "trusted" },
  };
}

/** Lifted verbatim from tests/operations/awaiting-human-input.test.ts. */
async function registeredArtifacts(root: string, runId: string) {
  const workspace = await RunWorkspace.open(root, runId);
  try { return await workspace.readRegisteredArtifacts(); } finally { await workspace.close(); }
}

/** Lifted verbatim from tests/operations/awaiting-human-input.test.ts. */
async function runStatus(root: string, runId: string): Promise<string> {
  return String((JSON.parse(await readFile(join(root, "qa-results", runId, "run-metadata.json"), "utf8")) as { status: string }).status);
}

/**
 * Registers a lane-2 batch into an open (paused) run, without running Playwright — but crediting an
 * ALREADY-registered test-case by its identity triple, never inventing one.
 *
 * This differs from the brief's literal helper, which registered its own fresh `test-case` artifact.
 * That breaks on the very next `RunWorkspace.open()`: `regressionSelectionRule` (src/core/semantic-rules.ts)
 * re-derives `selectRegressionCases` at read time over EVERY `test-case` in the workspace and requires
 * the result to still equal the persisted decision — so growing the test-case pool after `select-regression`
 * ran invalidates a selection nothing else touched. The real observed-execution lane never does this:
 * `mapObservedReport` (src/observed/report-mapping.ts) only ever credits a case the run already imported,
 * excluding rather than inventing anything else. Crediting an existing, deliberately-unselected case
 * (the bundle's `TC-REG-EXCLUDED`) is both what a real Runtime-Observed Execution can do and what keeps
 * this fixture from tripping a rule that is correct, not the one under test here.
 */
async function registerObservedBatch(root: string, runId: string, identity: { testCaseId: string; revisionId: string; instanceId: string }) {
  const workspace = await RunWorkspace.open(root, runId);
  try {
    const registered = await workspace.readRegisteredArtifacts();
    const testCase = registered.find((artifact) => artifact.record.type === "test-case"
      && artifact.value.testCaseId === identity.testCaseId && artifact.value.revisionId === identity.revisionId && artifact.value.instanceId === identity.instanceId);
    if (!testCase) throw new Error(`Expected an already-registered test-case for ${identity.testCaseId}/${identity.revisionId}/${identity.instanceId}`);
    await workspace.registerArtifactValue({ type: "test-result-batch", relationships: [testCase.record.id], provenance: "runtime-observed", value: {
      artifactType: "test-result-batch", schemaVersion: "4.0.0", producerVersion: "1.0.0",
      executionId: `EXEC-${identity.testCaseId}`, runId, commitSha: "0".repeat(40), specTreeSha256: "1".repeat(64),
      startedAt: "2026-07-31T00:00:00.000Z", finishedAt: "2026-07-31T00:00:01.000Z",
      entries: [{
        entryId: "ENTRY-1", testCaseId: identity.testCaseId, testCaseRevisionId: identity.revisionId, testCaseInstanceId: identity.instanceId,
        status: "PASSED", failureClassification: "NONE", executionSurface: "api",
        steps: [{ stepId: "observed-open", status: "PASSED", durationMs: 5 }],
      }],
    } });
  } finally { await workspace.close(); }
}

describe("AWAITING_OBSERVED_EXECUTION: the pause in front of execute-browser-test", () => {
  it("pauses before execute-browser-test when the run expects a Runtime-Observed Execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-observed-pause-")); roots.push(root);
    const bundle = await regressionBundleWithExcludedHumanReviewPlan(root);

    const paused = await regressionTester()({ ...regressionInput(root, bundle), observedExecution: { expected: true } });

    expect(paused.outcome).toBe("AWAITING_OBSERVED_EXECUTION");
    expect(paused.pendingObservedExecution).toMatchObject({ operation: "execute-browser-test", command: "execute playwright" });
    // Consequence, not just the outcome string: the selection ran, nothing was driven, no gate exists,
    // and the run is still writable.
    const artifacts = await registeredArtifacts(root, paused.runId);
    expect(artifacts.some((artifact) => artifact.record.type === "regression-selection")).toBe(true);
    expect(artifacts.filter((artifact) => artifact.record.type === "test-result")).toHaveLength(0);
    expect(artifacts.some((artifact) => artifact.record.type === "release-gate")).toBe(false);
    // No status named "IN_PROGRESS" exists in this workspace's lifecycle (CREATED -> RUNNING ->
    // FINALIZING -> a terminal status; see run-workspace.ts). A pause never finalizes, so the negative
    // check the human-input pause already uses (awaiting-human-input.test.ts) is the honest assertion.
    expect(await runStatus(root, paused.runId)).not.toMatch(/COMPLETED|BLOCKED|ABORTED/);
  }, 120_000);

  it("pauses again on a resume that still has no observed execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-observed-pause-again-")); roots.push(root);
    const bundle = await regressionBundleWithExcludedHumanReviewPlan(root);
    const tester = regressionTester();
    const first = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });

    const second = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: first.runId });

    expect(second.outcome).toBe("AWAITING_OBSERVED_EXECUTION");
    expect(second.runId).toBe(first.runId);
    expect((await registeredArtifacts(root, first.runId)).filter((artifact) => artifact.record.type === "test-result")).toHaveLength(0);
  }, 120_000);

  it("does not pause when the input declares no observed execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-observed-absent-")); roots.push(root);
    const bundle = await regressionBundleWithExcludedHumanReviewPlan(root);

    const result = await regressionTester()(regressionInput(root, bundle));

    expect(result.outcome).toBe("COMPLETED");
    expect((await registeredArtifacts(root, result.runId)).filter((artifact) => artifact.record.type === "test-result")).toHaveLength(1);
  }, 120_000);

  it("resumes and drives the selection once a batch exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-observed-resume-")); roots.push(root);
    const bundle = await regressionBundleWithExcludedHumanReviewPlan(root);
    const tester = regressionTester();
    const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
    // TC-REG-EXCLUDED is registered but not part of the selection: this task drives the whole selection
    // on resume regardless of what lane 2 observed, so the one selected case (TC-REG-INCLUDED) still runs.
    await registerObservedBatch(root, paused.runId, { testCaseId: "TC-REG-EXCLUDED", revisionId: "REV-REG-EXCLUDED", instanceId: "INSTANCE-REG-EXCLUDED" });

    const resumed = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });

    expect(resumed.outcome).toBe("COMPLETED");
    expect((await registeredArtifacts(root, paused.runId)).filter((artifact) => artifact.record.type === "test-result")).toHaveLength(1);
  }, 120_000);

  it("rejects a resume whose observedExecution disagrees with the paused run", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-observed-checksum-")); roots.push(root);
    const bundle = await regressionBundleWithExcludedHumanReviewPlan(root);
    const tester = regressionTester();
    const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });

    await expect(tester({ ...regressionInput(root, bundle), resumeRunId: paused.runId }))
      .rejects.toThrow(/checkpoint|input|checksum/i);
  }, 120_000);
});
