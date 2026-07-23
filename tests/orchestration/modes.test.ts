import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { operationsForMode, resolveOperationOrder } from "../../src/orchestration/modes.js";
import { createWorkflowRunner } from "../../src/operations/run-workflow.js";

describe("workflow mode operation plans", () => {
  it("uses the minimal dependency-ordered operations for plan and execute", () => {
    expect(operationsForMode("plan")).toEqual(["ingest-requirement-analysis", "ingest-testcases", "ingest-coverage-obligation"]);
    expect(operationsForMode("execute")).toEqual(["execute-browser-test", "collect-evidence"]);
  });

  it("keeps cleanup out of the public QA Tester modes", () => {
    expect(() => operationsForMode("cleanup" as never)).toThrow(/unsupported.*mode/i);
  });

  it("takes transitive metadata dependencies and rejects cycles deterministically", () => {
    expect(resolveOperationOrder(["report"], { report: { dependsOn: ["evidence"] }, evidence: { dependsOn: ["execute"] }, execute: { dependsOn: [] } })).toEqual(["execute", "evidence", "report"]);
    expect(() => resolveOperationOrder(["a"], { a: { dependsOn: ["b"] }, b: { dependsOn: ["a"] } })).toThrow(/cycle/i);
  });

  it("makes a retest reproduce its target before selecting regression", () => {
    expect(operationsForMode("retest")).toEqual(["reproduce-bug", "select-regression", "execute-browser-test", "collect-evidence", "derive-retest-verdict"]);
  });

  it("runs typed exploratory operations in order and never requires a skill shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-workflow-"));
    const calls: string[] = [];
    try {
      const result = await createWorkflowRunner({ "collect-evidence": () => { calls.push("collect-evidence"); return Promise.resolve(); } })({
        root, mode: "exploratory",
        environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "ENV-1", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false },
        charter: { charterId: "CHAR-1", mission: "Explore sign in", scope: ["/login"], roles: ["member"], heuristics: ["boundary"], safetyRules: ["test account"], actionBudget: 1, timeBudgetMinutes: 1, stopConditions: ["budget reached"] },
      });
      expect(result.operationOrder).toEqual(["register-exploration-charter", "collect-evidence"]);
      expect(calls).toEqual(["collect-evidence"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("denies execute before invoking an operation without approved canonical revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-workflow-"));
    let invoked = false;
    try {
      await expect(createWorkflowRunner({ "execute-browser-test": () => { invoked = true; return Promise.resolve(); }, "collect-evidence": () => Promise.resolve(undefined) })({
        root, mode: "execute",
        environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "ENV-1", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false },
      })).rejects.toThrow(/approved canonical/i);
      expect(invoked).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
