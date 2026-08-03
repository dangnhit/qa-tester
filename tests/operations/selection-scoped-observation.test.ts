import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Text } from "../../src/core/checksum.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { finalizeWorkflowOutcome, workflowOperationAdaptersForTests } from "../../src/operations/run-workflow.js";
import { sha256Fingerprint } from "../../src/planning/testcase-revision.js";
import { regressionCaseFromCanonical, registerChangeScope } from "../../src/regression/change-scope.js";
import { selectRegressionCases } from "../../src/regression/selector.js";

/**
 * Phase 9 items 3.2 and 3.3 — the two readers that asked "does any observed case exist ANYWHERE in this
 * workspace" when they meant "is THIS run's selection covered".
 *
 * The discriminating fixture, and the only one that discriminates: a registered `test-result-batch` that
 * credits `TC-SEL-OUTSIDE`, an identity the regression selection EXCLUDED. That batch is entirely valid —
 * `testResultBatchRule` binds every entry to exactly one registered test case, and this one is bound —
 * so nothing upstream refuses it. A fixture holding a batch that credits the SELECTED case proves
 * nothing here: the workspace-wide reader and the selection-scoped one answer it identically.
 *
 * Driven through the real adapter map and the real `finalizeWorkflowOutcome` rather than through a
 * browser run: both readers take a `RunWorkspace` and read its registered artifacts, so a hand-built
 * workspace exercises exactly the code the run loop reaches, without launching Chromium.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const environment = {
  artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0",
  environmentProfileId: "ENV-SEL", name: "Selection scope fixture", classification: "test",
  baseUrl: "https://example.test", productionReadOnly: false,
} as const;

type Identity = Readonly<{ testCaseId: string; revisionId: string; instanceId: string }>;

const selectedCase: Identity = { testCaseId: "TC-SEL-IN", revisionId: "REV-SEL-IN", instanceId: "INSTANCE-SEL-IN" };
const excludedCase: Identity = { testCaseId: "TC-SEL-OUTSIDE", revisionId: "REV-SEL-OUTSIDE", instanceId: "INSTANCE-SEL-OUTSIDE" };

/** One declared change mapping to `REQ-SEL` alone, so the selector keeps the case whose coverage names
 *  that requirement and excludes the one whose explicit `regressionIndex` maps to nothing declared. */
const changes = [{ id: "CHANGE-SEL", requirementIds: ["REQ-SEL"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }] as const;

type ObservedEntry = Readonly<{ identity: Identity; status: "PASSED" | "FAILED" }>;
type Filtering = Readonly<{ filtered: boolean }>;

/**
 * A workspace holding both canonical cases and one `runtime-observed` batch crediting exactly `observed`.
 *
 * `filtered` picks which of the two states a run's selection scope can be in. A FILTERED (`regression`)
 * run registers the change scope and the `regression-selection` that keeps only `selectedCase`; an
 * UNFILTERED (`execute`) run registers neither, and its scope is the whole imported canonical bundle —
 * both registered cases. The unfiltered rows are what stop the scope collapsing to "nothing" for the two
 * modes that have no selection artifact to read.
 *
 * The `regression-selection` value is built the way `registerSelection` (src/operations/run-workflow.ts)
 * builds it, including the `decisionChecksum` over the selector's own output, because
 * `regressionSelectionRule` re-runs the selector and compares byte for byte.
 */
async function scopedWorkspace(root: string, observed: readonly ObservedEntry[], options: Filtering = { filtered: true }): Promise<RunWorkspace> {
  const workspace = await RunWorkspace.create({ root, mode: options.filtered ? "regression" : "execute", environmentProfile: environment });
  const requirement = await workspace.registerArtifactValue({ type: "requirement-analysis", relationships: [], value: {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-SEL",
    statements: [{ requirementId: "REQ-SEL", sourceProvenance: { kind: "user", reference: "phase-9-task-4" }, normalizedText: "Member must be able to save an email.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] }],
  } });
  const dsl = { steps: [{ id: "open", action: { kind: "open", url: "https://example.test" }, sideEffect: "none" }] };
  const planCase = (identity: Identity, title: string) => ({
    testCaseId: identity.testCaseId, title,
    expectedResults: [{ id: `ER-${identity.testCaseId}`, requirementId: "REQ-SEL", authority: "AUTHORITATIVE", text: "Saved" }],
    steps: [{ id: "open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [],
    browserExecution: { revisionId: identity.revisionId, instanceId: identity.instanceId, browserDsl: dsl, browserDslFingerprint: sha256Fingerprint(dsl) },
  });
  const plan = await workspace.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-SEL",
    approvalPolicy: { mode: "auto-approve-safe" },
    testCases: [planCase(selectedCase, "Save email (selected)"), planCase(excludedCase, "Save email (outside the selection)")],
  } });
  const canonicalCase = (identity: Identity, title: string, behavior: string, outside: boolean) => workspace.registerArtifactValue({ type: "test-case", relationships: [plan.id], value: {
    artifactType: "test-case", schemaVersion: "3.0.0", producerVersion: "1.0.0",
    testCaseId: identity.testCaseId, revisionId: identity.revisionId, instanceId: identity.instanceId,
    title, steps: [{ id: "open", action: "navigate", sideEffect: "none" }],
    coverage: { requirementId: "REQ-SEL", role: "member", behavior, browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
    ...(outside ? { regressionIndex: { requirementIds: [], codeSurfaces: ["outside-surface"], declaredDependencies: [], gitPaths: [], userScope: [] } } : {}),
  } });
  const caseIn = await canonicalCase(selectedCase, "Save email (selected)", "save email", false);
  const caseOutside = await canonicalCase(excludedCase, "Save email (outside the selection)", "save email outside", true);
  // Both exist so `evaluatePublicTerminalProfile("execute", …)` is SATISFIED and `validation.valid` is
  // true. Without them `finalizeWorkflowOutcome` returns COMPLETED_WITH_FAILURES from `!validation.valid`
  // alone — `publicTerminalRequirements.execute` (src/core/artifact-profiles.ts) requires a
  // `coverage-obligation` and an `evidence`/`evidence-gap` — and every assertion about the terminal
  // outcome below would hold with the lane-2 failure clause deleted outright. `regression` has no
  // `publicTerminalRequirements` entry at all, so its rows never depended on this; they are registered on
  // both branches anyway so one fixture shape serves both, and so the filtered rows keep asserting
  // `validation.valid` for a reason rather than by luck.
  await workspace.registerArtifactValue({ type: "coverage-obligation", relationships: [requirement.id], value: {
    artifactType: "coverage-obligation", schemaVersion: "4.0.0", producerVersion: "1.0.0",
    obligationId: "COV-SEL", requirementAnalysisArtifactId: requirement.id, requirementId: "REQ-SEL",
    role: "member", behavior: "save email", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 },
    accessibilityMethod: null, risk: "low", required: true, outcome: "Saved",
  } });
  // OPERATIONAL scope, so it binds no attempt: this fixture registers no `test-result`, and an
  // attempt-scoped gap would need exactly one (`evidenceGapRule`). "Lane 2 reported no evidence" is the
  // honest reading for a run credited entirely by an observed batch.
  await workspace.registerArtifactValue({ type: "evidence-gap", relationships: [], value: {
    artifactType: "evidence-gap", schemaVersion: "2.0.0", producerVersion: "1.0.0",
    evidenceGapId: "GAP-SEL", runId: workspace.runId, scope: "operational",
    reason: "The observed execution reported no evidence artifacts.", affectedClaim: "observed execution evidence",
  } });
  if (options.filtered) {
    const scope = await registerChangeScope({ workspace, changes: [...changes], provenance: { kind: "declared-change", reference: "phase-9-task-4" } });
    const registered = await workspace.readRegisteredArtifacts();
    const selection = selectRegressionCases({ changes: [...changes], testCases: registered.filter((artifact) => artifact.record.type === "test-case").map((artifact) => regressionCaseFromCanonical(artifact.value)) });
    if (selection.selected.length !== 1 || selection.selected[0]?.testCaseId !== selectedCase.testCaseId) throw new Error("Fixture must select exactly the one in-scope case");
    await workspace.registerArtifactValue({ type: "regression-selection", relationships: [scope.id, caseIn.id, caseOutside.id], value: {
      artifactType: "regression-selection", schemaVersion: "1.0.0", producerVersion: "0.1.0", selectionId: `REG-${workspace.runId}`, runId: workspace.runId,
      changeScopeArtifactId: scope.id, changeScopeSha256: scope.sha256, decisionChecksum: sha256Text(JSON.stringify(selection)), ...selection,
    }, provenance: "runtime" });
  }
  await workspace.registerArtifactValue({ type: "test-result-batch", provenance: "runtime-observed", relationships: [caseIn.id, caseOutside.id], value: {
    artifactType: "test-result-batch", schemaVersion: "4.0.0", producerVersion: "1.0.0",
    executionId: "EXEC-SEL", runId: workspace.runId, commitSha: "0".repeat(40), specTreeSha256: "1".repeat(64),
    startedAt: "2026-08-02T00:00:00.000Z", finishedAt: "2026-08-02T00:00:01.000Z",
    entries: observed.map((item, index) => ({
      entryId: `ENTRY-${index + 1}`, testCaseId: item.identity.testCaseId, testCaseRevisionId: item.identity.revisionId, testCaseInstanceId: item.identity.instanceId,
      status: item.status, failureClassification: item.status === "PASSED" ? "NONE" : "UNDETERMINED", executionSurface: "api",
      steps: [{ stepId: "observed-open", status: item.status, durationMs: 5 }],
    })),
  } });
  return workspace;
}

/** The postcondition `execute-browser-test` and `reproduce-bug` share, taken off the production adapter
 *  map rather than re-implemented, so a change to which postcondition either operation declares breaks
 *  these rows too. */
const assertResultPostcondition = workflowOperationAdaptersForTests()["execute-browser-test"].assertPostcondition;

describe("assertResultPostcondition — an empty output is legal only when THIS run's selection was observed (item 3.3)", () => {
  it("refuses an empty execution output when the batch covers nothing the selection named", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-selection-scope-outside-")); roots.push(root);
    const workspace = await scopedWorkspace(root, [{ identity: excludedCase, status: "PASSED" }]);
    try {
      await expect(assertResultPostcondition(workspace, [])).rejects.toThrow(/must return registered test-result references/);
    } finally { await workspace.close(); }
  });

  it("accepts an empty execution output when the batch covers the case the selection named", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-selection-scope-inside-")); roots.push(root);
    const workspace = await scopedWorkspace(root, [{ identity: selectedCase, status: "PASSED" }]);
    try {
      await expect(assertResultPostcondition(workspace, [])).resolves.toBeUndefined();
    } finally { await workspace.close(); }
  });

  /** An UNFILTERED run has no `regression-selection` to read, and its scope is the imported bundle — so
   *  the very same batch that is out of scope for the filtered run above is in scope here. Without this
   *  row a resolver that answered "nothing is selected" for an unfiltered run would look correct. */
  it("accepts an empty execution output in an unfiltered run whose scope is the whole imported bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-selection-scope-unfiltered-")); roots.push(root);
    const workspace = await scopedWorkspace(root, [{ identity: excludedCase, status: "PASSED" }], { filtered: false });
    try {
      await expect(assertResultPostcondition(workspace, [])).resolves.toBeUndefined();
    } finally { await workspace.close(); }
  });
});

describe("finalizeWorkflowOutcome — an observed failure counts only inside THIS run's selection (item 3.2)", () => {
  it("does not report failure for a FAILED entry the selection excluded", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-selection-failure-outside-")); roots.push(root);
    const workspace = await scopedWorkspace(root, [{ identity: selectedCase, status: "PASSED" }, { identity: excludedCase, status: "FAILED" }]);
    try {
      const result = await finalizeWorkflowOutcome(workspace, "regression");
      expect(result.validation.valid).toBe(true);
      expect(result.outcome).toBe("COMPLETED");
    } finally { await workspace.close(); }
  });

  it("still reports failure for a FAILED entry the selection named", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-selection-failure-inside-")); roots.push(root);
    const workspace = await scopedWorkspace(root, [{ identity: selectedCase, status: "FAILED" }]);
    try {
      expect((await finalizeWorkflowOutcome(workspace, "regression")).outcome).toBe("COMPLETED_WITH_FAILURES");
    } finally { await workspace.close(); }
  });

  /**
   * The unfiltered counterpart: the same FAILED entry that is out of scope for the filtered run above is
   * in scope for a run with no selection artifact, and must still be reported.
   *
   * `validation.valid` is asserted FIRST and deliberately. `finalizeWorkflowOutcome` returns
   * COMPLETED_WITH_FAILURES for `hasExecutionFailures || !validation.valid`, so without that assertion an
   * `execute`-mode fixture missing any `publicTerminalRequirements` artifact would satisfy this row with
   * the lane-2 clause deleted outright. Pinning `valid: true` is what makes the outcome turn on
   * `hasExecutionFailures` alone; the PASSED row below is the other half — same mode, same fixture, one
   * status apart — so the pair discriminates rather than merely asserting.
   */
  it("reports failure for the same FAILED entry in an unfiltered run", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-selection-failure-unfiltered-")); roots.push(root);
    const workspace = await scopedWorkspace(root, [{ identity: excludedCase, status: "FAILED" }], { filtered: false });
    try {
      const result = await finalizeWorkflowOutcome(workspace, "execute");
      expect(result.validation).toEqual({ valid: true, diagnostics: [] });
      expect(result.outcome).toBe("COMPLETED_WITH_FAILURES");
    } finally { await workspace.close(); }
  });

  it("reports no failure for the same unfiltered run when that entry PASSED", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-selection-pass-unfiltered-")); roots.push(root);
    const workspace = await scopedWorkspace(root, [{ identity: excludedCase, status: "PASSED" }], { filtered: false });
    try {
      const result = await finalizeWorkflowOutcome(workspace, "execute");
      expect(result.validation).toEqual({ valid: true, diagnostics: [] });
      expect(result.outcome).toBe("COMPLETED");
    } finally { await workspace.close(); }
  });
});
