import { aggregateStepResults } from "../browser/assertions.js";
import { executeBrowserStep } from "../browser/playwright/executor.js";
import { createBrowserAttemptSession } from "../browser/playwright/session.js";
import type { ActiveBrowserSession, BrowserStepResult, BrowserTestStep, CanonicalBrowserTestCase, ExecuteTestInput, InternalExecuteTestInput, TestAttempt } from "../browser/types.js";
import { validateBrowserTestDsl } from "../contracts/validator.js";
import { QaSkillsError } from "../core/errors.js";
import type { RegisteredWorkspaceArtifact } from "../core/run-workspace.js";

export const activeBrowserSessions = new Map<string, ActiveBrowserSession>();
const reservedAttemptIds = new Set<string>();
let executionTail: Promise<void> = Promise.resolve();

export function getActiveBrowserSession(attemptId: string): ActiveBrowserSession | undefined {
  return activeBrowserSessions.get(attemptId);
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function loadCanonicalTestCase(artifacts: readonly RegisteredWorkspaceArtifact[], testCaseArtifactId: string): CanonicalBrowserTestCase {
  const artifact = artifacts.find((candidate) => candidate.record.id === testCaseArtifactId && candidate.record.type === "test-case");
  if (!artifact) throw new QaSkillsError("Execution requires an approved registered test case artifact", "ARTIFACT_BINDING");
  const execution = artifact.value.execution;
  if (!object(execution) || typeof execution.testPlanArtifactId !== "string" || !object(execution.browserDsl)) {
    throw new QaSkillsError("Test case is not an approved executable browser instance", "ARTIFACT_BINDING");
  }
  const plan = artifacts.find((candidate) => candidate.record.id === execution.testPlanArtifactId && candidate.record.type === "test-plan");
  if (!plan || !artifact.record.relationships.includes(plan.record.id) || !object(plan.value.approvalDecision) || plan.value.approvalDecision.approved !== true) throw new QaSkillsError("Test case plan binding is not approved", "ARTIFACT_BINDING");
  const cases = plan.value.testCases;
  if (!Array.isArray(cases) || !cases.some((candidate) => object(candidate) && candidate.testCaseId === artifact.value.testCaseId)) {
    throw new QaSkillsError("Test case does not match its approved registered plan", "ARTIFACT_BINDING");
  }
  if (!validateBrowserTestDsl(execution.browserDsl).valid || !Array.isArray(execution.browserDsl.steps)) {
    throw new QaSkillsError("Approved browser test DSL is invalid", "INVALID_ARTIFACT");
  }
  if (typeof artifact.value.testCaseId !== "string" || typeof artifact.value.revisionId !== "string" || typeof artifact.value.instanceId !== "string") {
    throw new QaSkillsError("Registered test case identity is invalid", "ARTIFACT_BINDING");
  }
  return {
    testCaseId: artifact.value.testCaseId,
    revisionId: artifact.value.revisionId,
    instanceId: artifact.value.instanceId,
    ...(typeof artifact.value.title === "string" ? { title: artifact.value.title } : {}),
    browserDsl: { steps: execution.browserDsl.steps as BrowserTestStep[] }, artifact,
  };
}

function notRunStep(step: BrowserTestStep): BrowserStepResult {
  const now = new Date().toISOString();
  return { stepId: step.id, status: "NOT_RUN", startedAt: now, finishedAt: now, durationMs: 0, action: step.action, assertions: step.assertions ?? [] };
}

async function executeCanonical(input: InternalExecuteTestInput): Promise<TestAttempt> {
  const started = Date.now();
  const session = await createBrowserAttemptSession(input.browser, input.testCase);
  const contextId = `${input.attemptId}:context`;
  activeBrowserSessions.set(input.attemptId, session);
  const steps: BrowserStepResult[] = [];
  const secrets = new Set<string>();
  const resolveSecret = input.resolveSecret === undefined ? undefined : async (reference: Parameters<NonNullable<InternalExecuteTestInput["resolveSecret"]>>[0]) => {
    const value = await input.resolveSecret?.(reference);
    if (typeof value !== "string") throw new Error("Secret resolver returned a non-string value");
    secrets.add(value);
    return value;
  };
  let priorFailed = false;
  try {
    await input.onSessionActive?.({ attemptId: input.attemptId, session });
    for (const step of input.steps) {
      if (priorFailed && !(step.independent === true && step.sideEffect === "none")) { steps.push(notRunStep(step)); continue; }
      const result = await executeBrowserStep(session.page, step, session.telemetry, resolveSecret);
      steps.push(result);
      if (result.status === "FAILED") priorFailed = true;
    }
    const finished = Date.now();
    const scrub = (text: string) => [...secrets].reduce((result, secret) => secret.length === 0 ? result : result.replaceAll(secret, "[REDACTED]"), text);
    const safeSteps = steps.map((step) => step.error === undefined ? step : { ...step, error: scrub(step.error) });
    const safeTelemetry = session.telemetry.findings.map((finding) => ({ ...finding, message: scrub(finding.message), ...(finding.url === undefined ? {} : { url: scrub(finding.url) }) }));
    return { attemptId: input.attemptId, runId: input.runId, testCaseId: input.testCase.testCaseId, testCaseRevisionId: input.testCase.revisionId, testCaseInstanceId: input.testCase.instanceId, contextId, status: aggregateStepResults(safeSteps), startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(), steps: safeSteps, telemetry: safeTelemetry };
  } finally {
    activeBrowserSessions.delete(input.attemptId);
    await session.context.close();
  }
}

/** Public boundary: executes only a caller-identified, registered approved test instance. */
export async function executeTestInstance(input: ExecuteTestInput): Promise<TestAttempt> {
  if (!input.workspace) throw new QaSkillsError("Execution requires a workspace", "ARTIFACT_BINDING");
  if (!input.attemptId) throw new QaSkillsError("Execution requires a caller-owned attempt ID", "ARTIFACT_BINDING");
  if (reservedAttemptIds.has(input.attemptId)) throw new QaSkillsError("Attempt ID is already active or queued", "ARTIFACT_BINDING");
  reservedAttemptIds.add(input.attemptId);
  const operation = executionTail.then(async () => {
    const artifacts = await input.workspace.readRegisteredArtifacts();
    if (artifacts.some((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === input.attemptId)) {
      throw new QaSkillsError("Attempt ID is already registered", "ARTIFACT_BINDING");
    }
    const testCase = loadCanonicalTestCase(artifacts, input.testCaseArtifactId);
    return executeCanonical({ browser: input.browser, runId: input.workspace.runId, testCase, steps: testCase.browserDsl.steps, attemptId: input.attemptId, ...(input.resolveSecret ? { resolveSecret: input.resolveSecret } : {}), ...(input.onSessionActive ? { onSessionActive: input.onSessionActive } : {}) });
  });
  executionTail = operation.then(() => undefined, () => undefined);
  return operation.finally(() => reservedAttemptIds.delete(input.attemptId));
}
