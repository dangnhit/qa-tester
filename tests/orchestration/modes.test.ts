import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { operationsForMode } from "../../src/orchestration/modes.js";
import { runWorkflow } from "../../src/operations/run-workflow.js";

describe("workflow mode operation plans", () => {
  it("uses the minimal dependency-ordered operations for plan and execute", () => {
    expect(operationsForMode("plan")).toEqual(["ingest-requirement-analysis", "ingest-testcases", "ingest-coverage-obligation"]);
    expect(operationsForMode("execute")).toEqual(["execute-browser-test", "collect-evidence"]);
  });

  it("keeps cleanup out of the public QA Tester modes", () => {
    expect(() => operationsForMode("cleanup" as never)).toThrow(/unsupported.*mode/i);
  });

  it("makes a retest reproduce its target before selecting regression", () => {
    expect(operationsForMode("retest")).toEqual(["reproduce-bug", "select-regression", "execute-browser-test", "collect-evidence", "derive-retest-verdict"]);
  });

  it("runs typed exploratory operations in order and never requires a skill shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-workflow-"));
    const calls: string[] = [];
    try {
      const result = await runWorkflow({
        root, mode: "exploratory",
        environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "ENV-1", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false },
        charter: { charterId: "CHAR-1", mission: "Explore sign in", scope: ["/login"], roles: ["member"], heuristics: ["boundary"], safetyRules: ["test account"], actionBudget: 1, timeBudgetMinutes: 1, stopConditions: ["budget reached"] },
        operations: { "collect-evidence": () => { calls.push("collect-evidence"); return Promise.resolve(); } },
      });
      expect(result.operationOrder).toEqual(["register-exploration-charter", "collect-evidence"]);
      expect(calls).toEqual(["collect-evidence"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("denies execute before invoking an operation without approved canonical revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-workflow-"));
    let invoked = false;
    try {
      await expect(runWorkflow({
        root, mode: "execute",
        environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "ENV-1", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false },
        operations: { "execute-browser-test": () => { invoked = true; return Promise.resolve(); }, "collect-evidence": () => Promise.resolve(undefined) },
      })).rejects.toThrow(/approved canonical/i);
      expect(invoked).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
