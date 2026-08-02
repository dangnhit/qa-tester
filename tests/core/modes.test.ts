import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { operationNames, operationsForMode, resolveOperationOrder } from "../../src/core/modes.js";
import { createQaTester, createUnsafeWorkflowRunnerForTests, finalizeWorkflowOutcome, workflowOperationAdaptersForTests } from "../../src/operations/run-workflow.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { sha256Fingerprint } from "../../src/planning/testcase-revision.js";

describe("workflow mode operation plans", () => {
  it("uses the minimal dependency-ordered operations for plan and execute", () => {
    expect(operationsForMode("plan")).toEqual(["ingest-requirement-analysis", "ingest-testcases", "ingest-coverage-obligation"]);
    expect(operationsForMode("execute")).toEqual(["execute-browser-test", "collect-evidence"]);
  });

  it("keeps cleanup out of the public QA Tester modes", () => {
    expect(() => operationsForMode("cleanup" as never)).toThrow(/unsupported.*mode/i);
  });

  it("keeps callback orchestration out of the package public surface", async () => {
    const packageJson = JSON.parse(await readFile(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { exports: Record<string, string> };
    expect(Object.values(packageJson.exports)).not.toContain("./dist/operations/run-workflow.js");
    expect(JSON.stringify(packageJson.exports)).not.toContain("UnsafeWorkflowRunner");
  });

  it("takes transitive metadata dependencies and rejects cycles deterministically", () => {
    expect(resolveOperationOrder(["report"], { report: { dependsOn: ["evidence"] }, evidence: { dependsOn: ["execute"] }, execute: { dependsOn: [] } })).toEqual(["execute", "evidence", "report"]);
    expect(() => resolveOperationOrder(["a"], { a: { dependsOn: ["b"] }, b: { dependsOn: ["a"] } })).toThrow(/cycle/i);
  });

  it("keeps a closed adapter/postcondition for every declared operation", () => {
    const adapters = workflowOperationAdaptersForTests();
    expect(Object.keys(adapters).sort()).toEqual([...operationNames].sort());
    for (const operation of operationNames) expect(adapters[operation].name).toBe(operation);
  });

  it("makes a retest reproduce its target before selecting regression", () => {
    expect(operationsForMode("retest")).toEqual(["reproduce-bug", "select-regression", "execute-browser-test", "collect-evidence", "generate-bug-report", "derive-retest-verdict"]);
  });

  it("disposes failed attempts before every regression report or retest verdict", () => {
    expect(operationsForMode("regression")).toEqual(["select-regression", "execute-browser-test", "collect-evidence", "generate-bug-report", "generate-qa-report"]);
    expect(operationsForMode("retest").indexOf("generate-bug-report")).toBeLessThan(operationsForMode("retest").indexOf("derive-retest-verdict"));
  });

  it("runs exploratory mode as charter-registration-only and never drives evidence or report operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-workflow-"));
    const calls: string[] = [];
    try {
      const result = await createUnsafeWorkflowRunnerForTests({ "collect-evidence": () => { calls.push("collect-evidence"); return Promise.resolve(); }, "generate-qa-report": () => { calls.push("generate-qa-report"); return Promise.resolve(); } })({
        root, mode: "exploratory",
        environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "ENV-1", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false },
        charter: { charterId: "CHAR-1", mission: "Explore sign in", scope: ["/login"], roles: ["member"], heuristics: ["boundary"], safetyRules: ["test account"], actions: [{ actionId: "open", target: "/login", kind: "navigate", sideEffect: "none", safetyRuleId: "test account" }], actionBudget: 1, timeBudgetMinutes: 1, stopConditions: ["budget reached"] },
      });
      // Exploration moved to the agent lane: the runtime's exploratory deliverable is only the immutable charter.
      expect(result.operationOrder).toEqual(["register-exploration-charter"]);
      expect(calls).toEqual([]);
      expect(result.validation.valid).toBe(true);
      expect(result.outcome).toBe("COMPLETED");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("denies execute before invoking an operation without approved canonical revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-workflow-"));
    let invoked = false;
    try {
      await expect(createUnsafeWorkflowRunnerForTests({ "execute-browser-test": () => { invoked = true; return Promise.resolve(); }, "collect-evidence": () => Promise.resolve(undefined) })({
        root, mode: "execute",
        environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "ENV-1", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false },
      })).rejects.toThrow(/approved canonical/i);
      expect(invoked).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("returns a safe awaiting-runtime checkpoint when a public full workflow has no configured runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-workflow-"));
    try {
      await expect(createQaTester({})({
        root, mode: "full",
        environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "ENV-1", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false },
      })).resolves.toMatchObject({ outcome: "AWAITING_RUNTIME" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("returns the finalized metadata outcome when a passing attempt still fails the artifact profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-workflow-invalid-profile-"));
    const environment = { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "ENV-INVALID-PROFILE", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false };
    const workspace = await RunWorkspace.create({ root, mode: "full", environmentProfile: environment });
    try {
      const requirement = await workspace.registerArtifactValue({ type: "requirement-analysis", relationships: [], value: { artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-INVALID-PROFILE", statements: [{ requirementId: "REQ-INVALID-PROFILE", sourceProvenance: { kind: "user", reference: "test" }, normalizedText: "The page must open.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] }] } });
      const dsl = { steps: [{ id: "open", action: { kind: "open", url: "https://example.test" }, sideEffect: "none" }] };
      const plan = await workspace.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: { artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-INVALID-PROFILE", approvalPolicy: { mode: "auto-approve-safe" }, testCases: [{ testCaseId: "TC-INVALID-PROFILE", title: "Open", expectedResults: [{ id: "ER-INVALID-PROFILE", requirementId: "REQ-INVALID-PROFILE", authority: "AUTHORITATIVE", text: "Open" }], steps: [{ id: "open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [], browserExecution: { revisionId: "REV-INVALID-PROFILE", instanceId: "INSTANCE-INVALID-PROFILE", browserDsl: dsl, browserDslFingerprint: sha256Fingerprint(dsl) } }] } });
      const testcase = await workspace.registerArtifactValue({ type: "test-case", relationships: [plan.id], value: { artifactType: "test-case", schemaVersion: "3.0.0", producerVersion: "1.0.0", testCaseId: "TC-INVALID-PROFILE", revisionId: "REV-INVALID-PROFILE", instanceId: "INSTANCE-INVALID-PROFILE", title: "Open", steps: [{ id: "open", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ-INVALID-PROFILE", role: "member", behavior: "open", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Open" } } });
      await workspace.registerArtifactValue({ type: "test-result", relationships: [testcase.id], value: { artifactType: "test-result", schemaVersion: "3.0.0", producerVersion: "1.0.0", attemptId: "ATT-INVALID-PROFILE", runId: workspace.runId, testCaseId: "TC-INVALID-PROFILE", testCaseRevisionId: "REV-INVALID-PROFILE", testCaseInstanceId: "INSTANCE-INVALID-PROFILE", status: "PASSED", failureClassification: "NONE", observedEngine: "chromium", steps: [{ stepId: "open", status: "PASSED", durationMs: 1 }], startedAt: "2026-07-23T00:00:00.000Z", finishedAt: "2026-07-23T00:00:01.000Z" } });

      const result = await finalizeWorkflowOutcome(workspace, "full");
      const metadata = JSON.parse(await readFile(join(workspace.path, "run-metadata.json"), "utf8")) as { status: string };
      expect(result.outcome).toBe("COMPLETED_WITH_FAILURES");
      expect(result.validation.valid).toBe(false);
      expect(metadata.status).toBe(result.outcome);
      // No release-gate artifact was ever registered on this hand-built
      // workspace: the recommendation must stay undefined, never guessed.
      expect(result.releaseRecommendation).toBeUndefined();
    } finally {
      await workspace.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
