import { randomUUID } from "node:crypto";

import { aggregateStepResults } from "../browser/assertions.js";
import { executeBrowserStep } from "../browser/playwright/executor.js";
import { createBrowserAttemptSession } from "../browser/playwright/session.js";
import type { ActiveBrowserSession, BrowserStepResult, BrowserTestStep, ExecuteTestInput, TestAttempt } from "../browser/types.js";

export const activeBrowserSessions = new Map<string, ActiveBrowserSession>();

export function getActiveBrowserSession(attemptId: string): ActiveBrowserSession | undefined {
  return activeBrowserSessions.get(attemptId);
}

function notRunStep(step: BrowserTestStep): BrowserStepResult {
  const now = new Date().toISOString();
  return { stepId: step.id, status: "NOT_RUN", startedAt: now, finishedAt: now, durationMs: 0, action: step.action, assertions: step.assertions ?? [] };
}

export async function executeTestInstance(input: ExecuteTestInput): Promise<TestAttempt> {
  const started = Date.now();
  const attemptId = randomUUID();
  const session = await createBrowserAttemptSession(input.browser, input.testCase);
  const contextId = session.context.pages().length > 0 ? `${attemptId}:context` : `${attemptId}:empty`;
  activeBrowserSessions.set(attemptId, session);
  const steps: BrowserStepResult[] = [];
  let priorFailed = false;
  try {
    for (const step of input.steps) {
      const permittedAfterFailure = step.independent === true && step.sideEffect === "none";
      if (priorFailed && !permittedAfterFailure) {
        steps.push(notRunStep(step));
        continue;
      }
      const result = await executeBrowserStep(session.page, step, session.telemetry, input.resolveSecret);
      steps.push(result);
      if (result.status === "FAILED") priorFailed = true;
    }
    const finished = Date.now();
    return {
      attemptId,
      runId: input.runId,
      testCaseId: input.testCase.testCaseId,
      testCaseRevisionId: input.testCase.revisionId,
      testCaseInstanceId: input.testCase.instanceId,
      contextId,
      status: aggregateStepResults(steps),
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      steps,
      telemetry: session.telemetry.findings,
    };
  } finally {
    activeBrowserSessions.delete(attemptId);
    await session.context.close();
  }
}
