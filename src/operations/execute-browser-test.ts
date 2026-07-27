import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { Browser } from "@playwright/test";

import { aggregateStepResults } from "../browser/assertions.js";
import { executeBrowserStep } from "../browser/playwright/executor.js";
import { createBrowserAttemptSession } from "../browser/playwright/session.js";
import { activeBrowserSessions } from "../browser/session-registry.js";
import type { BrowserStepResult, BrowserTestStep, CanonicalBrowserTestCase, ExecuteTestInput, InternalExecuteTestInput, TestAttempt } from "../browser/types.js";
import { validateBrowserTestDsl } from "../contracts/validator.js";
import { indexByAttemptId } from "../core/artifact-index.js";
import { QaSkillsError } from "../core/errors.js";
import type { ExecutionProvenance } from "../core/provenance.js";
import type { RegisteredWorkspaceArtifact } from "../core/run-workspace.js";
import { isRecord } from "../core/values.js";
import { sha256Fingerprint } from "../planning/testcase-revision.js";
import { navigationPolicyFromProfile, type LaneSafetyContext } from "../safety/navigation.js";
import { authorizeStep } from "../safety/side-effects.js";

const reservedAttemptIds = new Set<string>();
let executionTail: Promise<void> = Promise.resolve();

function loadCanonicalTestCase(artifacts: readonly RegisteredWorkspaceArtifact[], testCaseArtifactId: string): CanonicalBrowserTestCase {
  const artifact = artifacts.find((candidate) => candidate.record.id === testCaseArtifactId && candidate.record.type === "test-case");
  if (!artifact) throw new QaSkillsError("Execution requires an approved registered test case artifact", "ARTIFACT_BINDING");
  const plan = artifacts.find((candidate) => candidate.record.type === "test-plan" && artifact.record.relationships.includes(candidate.record.id));
  const autoApproved = plan && isRecord(plan.value.approvalDecision) && plan.value.approvalDecision.approved === true;
  const humanApproved = plan && artifacts.some((candidate) => candidate.record.type === "approval-decision"
    && candidate.record.relationships.filter((id) => id === plan.record.id).length === 1
    && candidate.value.planArtifactId === plan.record.id
    && candidate.value.planSha256 === plan.record.sha256
    && candidate.value.decision === "APPROVED");
  if (!plan || (!autoApproved && !humanApproved)) throw new QaSkillsError("Test case plan binding is not approved", "ARTIFACT_BINDING");
  const cases: unknown = plan.value.testCases;
  const planCases: readonly unknown[] = Array.isArray(cases) ? cases as unknown[] : [];
  const planCase = planCases.find((candidate) => isRecord(candidate)
    && candidate.testCaseId === artifact.value.testCaseId
    && candidate.browserExecution !== null && isRecord(candidate.browserExecution)
    && candidate.browserExecution.revisionId === artifact.value.revisionId
    && candidate.browserExecution.instanceId === artifact.value.instanceId);
  if (!isRecord(planCase)) {
    throw new QaSkillsError("Test case revision or instance does not match its approved registered plan binding", "ARTIFACT_BINDING");
  }
  const execution = planCase.browserExecution;
  if (!isRecord(execution) || typeof execution.revisionId !== "string" || typeof execution.instanceId !== "string" || !isRecord(execution.browserDsl) || typeof execution.browserDslFingerprint !== "string") {
    throw new QaSkillsError("Approved test plan entry has no browser execution binding", "ARTIFACT_BINDING");
  }
  if (execution.revisionId !== artifact.value.revisionId || execution.instanceId !== artifact.value.instanceId) {
    throw new QaSkillsError("Approved test plan entry does not match the test case revision and instance", "ARTIFACT_BINDING");
  }
  if (sha256Fingerprint(execution.browserDsl) !== execution.browserDslFingerprint || !validateBrowserTestDsl(execution.browserDsl).valid || !Array.isArray(execution.browserDsl.steps)) {
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
    ...(isRecord(artifact.value.coverage) && isRecord(artifact.value.coverage.viewport)
      && typeof artifact.value.coverage.viewport.width === "number"
      && typeof artifact.value.coverage.viewport.height === "number"
      ? { browser: { viewport: { width: artifact.value.coverage.viewport.width, height: artifact.value.coverage.viewport.height } } }
      : {}),
    browserDsl: { steps: execution.browserDsl.steps as BrowserTestStep[] },
    authoritativeExpectedResultIds: Array.isArray(planCase.expectedResults)
      ? planCase.expectedResults.filter(isRecord).filter((result) => result.authority === "AUTHORITATIVE" && typeof result.id === "string").map((result) => result.id as string)
      : [],
    artifact,
  };
}

function notRunStep(step: BrowserTestStep): BrowserStepResult {
  const now = new Date().toISOString();
  return { stepId: step.id, status: "NOT_RUN", startedAt: now, finishedAt: now, durationMs: 0, action: step.action, assertions: step.assertions ?? [] };
}

function blockedStep(step: BrowserTestStep, reasons: readonly string[]): BrowserStepResult {
  const now = new Date().toISOString();
  return { stepId: step.id, status: "BLOCKED", startedAt: now, finishedAt: now, durationMs: 0, action: step.action, assertions: step.assertions ?? [], error: `Safety denied: ${reasons.join(", ")}`, failureOrigin: "action" };
}

function permitTarget(step: BrowserTestStep): string {
  return step.action.kind === "open" && typeof step.action.url === "string" ? step.action.url : JSON.stringify(step.action);
}

/**
 * The one place the engine is MEASURED (CONTEXT.md:442): whatever the live handle names itself, taken
 * at the moment that handle is about to drive the attempt. Nothing here consults `test-case.coverage`
 * — a declared label agreeing with an obligation is precisely the defect this replaces.
 *
 * The handle is read structurally rather than trusted through its `Browser` type because the type is
 * only a compile-time claim: a partial double, a remote/CDP-connected handle, or a future non-Playwright
 * driver can all reach here. An engine that cannot be determined is REFUSED, not defaulted. A guessed
 * "chromium" would be indistinguishable from a measured one on the checksummed record, and would credit
 * a Browser Matrix member nothing ever ran — which is the exact failure this artifact exists to prevent.
 * Playwright documents `BrowserType.name()` as `string` ("For example: 'chromium', 'webkit' or
 * 'firefox'"), so the value is validated as a non-empty string and otherwise passed through unchanged.
 */
function observedEngineOf(browser: Browser): string {
  const reported: unknown = (browser as { browserType?: () => { name?: () => unknown } | undefined }).browserType?.()?.name?.();
  if (typeof reported !== "string" || reported.length === 0) {
    throw new QaSkillsError("Execution requires a browser that reports the engine it runs", "ARTIFACT_BINDING");
  }
  return reported;
}

async function executeCanonical(input: InternalExecuteTestInput & { safety: LaneSafetyContext; persistAttempt?: (attempt: TestAttempt) => Promise<void> }): Promise<TestAttempt> {
  // Read the engine BEFORE anything is driven: an attempt that could never carry an observed engine
  // must not navigate, act, or leave a side effect behind first.
  const observedEngine = observedEngineOf(input.browser);
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
    session.secrets.add(value);
    return value;
  };
  let priorFailed = false;
  try {
    await input.onSessionActive?.({ attemptId: input.attemptId, session });
    for (const step of input.steps) {
      if (priorFailed && !(step.independent === true && step.sideEffect === "none")) { steps.push(notRunStep(step)); continue; }
      if (input.authorizeStep !== undefined) {
        const decision = await input.authorizeStep(step);
        if (!decision.allowed) { steps.push(blockedStep(step, decision.reasons)); priorFailed = true; continue; }
      }
      const result = await executeBrowserStep(session.page, step, session.telemetry, resolveSecret, input.safety);
      steps.push(result);
      if (result.status === "FAILED") priorFailed = true;
    }
    const finished = Date.now();
    const scrub = (text: string) => [...secrets].reduce((result, secret) => secret.length === 0 ? result : result.replaceAll(secret, "[REDACTED]"), text);
    const safeSteps = steps.map((step) => step.error === undefined ? step : { ...step, error: scrub(step.error) });
    const safeTelemetry = session.telemetry.findings.map((finding) => ({ ...finding, message: scrub(finding.message), ...(finding.url === undefined ? {} : { url: scrub(finding.url) }) }));
    const attempt = { attemptId: input.attemptId, runId: input.runId, testCaseId: input.testCase.testCaseId, testCaseRevisionId: input.testCase.revisionId, testCaseInstanceId: input.testCase.instanceId, contextId, observedEngine, status: aggregateStepResults(safeSteps), startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(), steps: safeSteps, telemetry: safeTelemetry };
    // Register the canonical attempt before any evidence hook runs.  Evidence
    // descriptors are never provisional: each one binds this immutable result
    // while the browser context is still available for capture.
    await input.persistAttempt?.(attempt);
    await input.onBeforeSessionClose?.({ attempt, session });
    return attempt;
  } finally {
    activeBrowserSessions.delete(input.attemptId);
    session.secrets.clear();
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
    // A non-empty bucket is the `.some(...)` this replaces: any registered result on this attempt id
    // makes the attempt a duplicate, whether there is one or several.
    if (indexByAttemptId(
      artifacts.filter((artifact) => artifact.record.type === "test-result"),
      (artifact) => artifact.value.attemptId,
    ).get(input.attemptId).length > 0) {
      throw new QaSkillsError("Attempt ID is already registered", "ARTIFACT_BINDING");
    }
    const testCase = loadCanonicalTestCase(artifacts, input.testCaseArtifactId);
    // Lane-1 safety context: derive the navigation policy from the registered
    // environment profile (failing closed if it is missing/malformed) and own the
    // per-run upload root that every DSL `upload` file must resolve within.
    const uploadRoot = join(input.workspace.path, "uploads");
    await mkdir(uploadRoot, { recursive: true });
    const safety: LaneSafetyContext = { navigation: navigationPolicyFromProfile(artifacts.find((artifact) => artifact.record.type === "environment-profile")?.value), uploadRoot };
    const attempt = await executeCanonical({ browser: input.browser, runId: input.workspace.runId, testCase, steps: testCase.browserDsl.steps, attemptId: input.attemptId, safety, ...(input.resolveSecret ? { resolveSecret: input.resolveSecret } : {}), ...(input.onSessionActive ? { onSessionActive: input.onSessionActive } : {}), ...(input.onBeforeSessionClose ? { onBeforeSessionClose: input.onBeforeSessionClose } : {}), ...(input.environment === undefined ? {} : { authorizeStep: async (step) => authorizeStep({ sideEffect: step.sideEffect, action: step.action.kind, channel: "browser", target: permitTarget(step) }, input.environment!, input.externalPermitRegistry ?? []) }), persistAttempt: async (attempt) => {
      await input.workspace.registerArtifactValue({
        type: "test-result",
        value: {
          artifactType: "test-result", schemaVersion: "2.0.0", producerVersion: "0.1.0",
          attemptId: attempt.attemptId, runId: attempt.runId, testCaseId: attempt.testCaseId, testCaseRevisionId: attempt.testCaseRevisionId,
          testCaseInstanceId: attempt.testCaseInstanceId, status: attempt.status,
          // The MEASURED engine, carried straight from the attempt that observed it. Coverage matching
          // reads this field and never `test-case.coverage.browser` (CONTEXT.md:442).
          observedEngine: attempt.observedEngine,
          steps: attempt.steps.map((step) => ({
            stepId: step.stepId,
            status: step.status,
            durationMs: step.durationMs,
            ...(step.failureOrigin === undefined ? {} : { failureOrigin: step.failureOrigin }),
            ...(step.failedAssertion?.expectedResultId === undefined ? {} : { expectedResultId: step.failedAssertion.expectedResultId }),
          })),
          failureClassification: attempt.status === "PASSED"
            ? "NONE"
            : attempt.steps.some((step) => step.status === "FAILED"
              && step.failureOrigin === "assertion"
              && step.failedAssertion?.expectedResultId !== undefined
              && testCase.authoritativeExpectedResultIds.includes(step.failedAssertion.expectedResultId))
              ? "PRODUCT_DEFECT"
              : "UNDETERMINED",
          startedAt: attempt.startedAt, finishedAt: attempt.finishedAt,
        },
        relationships: [testCase.artifact.record.id],
        // Load-bearing type: a typo here becomes a compile error rather than a
        // silently non-crediting `test-result` (see creditsCoverage).
        provenance: "runtime-execution" satisfies ExecutionProvenance,
      });
    } });
    return attempt;
  });
  executionTail = operation.then(() => undefined, () => undefined);
  return operation.finally(() => reservedAttemptIds.delete(input.attemptId));
}
