import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { operationNames, operationsForMode, resolveOperationOrder } from "../../src/orchestration/modes.js";
import { createQaTester, createUnsafeWorkflowRunnerForTests, workflowOperationAdaptersForTests } from "../../src/operations/run-workflow.js";

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

  it("runs typed exploratory operations in order and never requires a skill shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-workflow-"));
    const calls: string[] = [];
    try {
      const result = await createUnsafeWorkflowRunnerForTests({ "collect-evidence": () => { calls.push("collect-evidence"); return Promise.resolve(); }, "generate-qa-report": () => Promise.resolve() })({
        root, mode: "exploratory",
        environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "ENV-1", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false },
        charter: { charterId: "CHAR-1", mission: "Explore sign in", scope: ["/login"], roles: ["member"], heuristics: ["boundary"], safetyRules: ["test account"], actions: [{ actionId: "open", target: "/login", kind: "navigate", sideEffect: "none", safetyRuleId: "test account" }], actionBudget: 1, timeBudgetMinutes: 1, stopConditions: ["budget reached"] },
      });
      expect(result.operationOrder).toEqual(["register-exploration-charter", "collect-evidence", "generate-qa-report"]);
      expect(calls).toEqual(["collect-evidence"]);
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
});
