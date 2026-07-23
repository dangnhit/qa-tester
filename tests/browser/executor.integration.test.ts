import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { activeBrowserSessions, executeTestInstance } from "../../src/operations/execute-browser-test.js";
import type { ExecuteTestInput } from "../../src/browser/types.js";
import { serveBrowserFixture } from "../../fixtures/browser/server.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/browser/basic.html");
let browser: Browser;
let baseUrl: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  const fixtureServer = await serveBrowserFixture(fixture);
  baseUrl = fixtureServer.baseUrl;
  closeServer = () => fixtureServer.close();
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => { if (browser !== undefined) await browser.close(); if (closeServer !== undefined) await closeServer(); });

const input = (): ExecuteTestInput => ({
  browser,
  attemptId: "ATTEMPT-1",
  testCaseArtifactId: "CASE-ARTIFACT",
  workspace: {
    readRegisteredArtifacts: () => Promise.resolve([{
      record: { id: "PLAN-ARTIFACT", type: "test-plan", relationships: [] },
      value: { testCases: [{ testCaseId: "TC-1" }] },
    }, {
      record: { id: "CASE-ARTIFACT", type: "test-case", relationships: ["PLAN-ARTIFACT"] },
      value: {
        testCaseId: "TC-1", revisionId: "REV-1", instanceId: "INSTANCE-1", title: "form",
        execution: { approval: "APPROVED", testPlanArtifactId: "PLAN-ARTIFACT", browserDsl: { steps: [
    { id: "open", action: { kind: "open", url: baseUrl }, sideEffect: "none" as const },
    { id: "fill", action: { kind: "fill", locator: { label: "Email" }, value: "qa@example.test" }, assertions: [{ kind: "value", locator: { label: "Email" }, value: "qa@example.test" }], sideEffect: "none" as const },
    { id: "click", action: { kind: "click", locator: { role: "button", name: "Save" } }, assertions: [{ kind: "text", locator: { testId: "result" }, text: "Saved" }], sideEffect: "none" as const },
        ] } },
      },
    }]),
  } as never,
});

describe("executeTestInstance", () => {
  it("rejects an unbound raw execution payload at the public operation boundary", async () => {
    const raw = input() as Record<string, unknown>;
    delete raw.workspace;
    await expect(executeTestInstance(raw as never)).rejects.toThrow(/workspace/i);
  });

  it("executes bounded steps in a fresh context and closes its registered active session", async () => {
    const attempt = await executeTestInstance(input());
    expect(attempt.status).toBe("PASSED");
    expect(attempt.steps.map((step) => step.status)).toEqual(["PASSED", "PASSED", "PASSED"]);
    expect(attempt.contextId).toBeTruthy();
    expect(activeBrowserSessions.get(attempt.attemptId)).toBeUndefined();
  });

  it("fails fast and marks dependent steps not run without retrying the whole test", async () => {
    const attempt = await executeTestInstance({
      ...input(),
      workspace: { readRegisteredArtifacts: async () => {
        const artifacts = await input().workspace.readRegisteredArtifacts();
        const testCase = artifacts[1] as unknown as { value: { execution: { browserDsl: { steps: unknown[] } } } };
        testCase.value.execution.browserDsl.steps = [
          { id: "bad", action: { kind: "open", url: baseUrl }, assertions: [{ kind: "count", locator: { role: "button" }, count: 2 }], sideEffect: "none" },
          { id: "dependent", action: { kind: "fill", locator: { label: "Email" }, value: "not-run" }, sideEffect: "none" },
          { id: "independent", action: { kind: "wait", milliseconds: 1 }, sideEffect: "none", independent: true },
        ];
        return artifacts;
      } },
    });
    expect(attempt.status).toBe("FAILED");
    expect(attempt.steps.map((step) => step.status)).toEqual(["FAILED", "NOT_RUN", "PASSED"]);
  });
});
