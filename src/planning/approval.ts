import { validateBrowserTestDsl, validatePlanningAction } from "../contracts/validator.js";
import { sha256Fingerprint } from "./testcase-revision.js";

export type ApprovalPolicy = { mode: "auto-approve-safe" | "human-review" };
export type ApprovalEnvironment = { classification: "local" | "test" | "staging" | "production" };
export type ApprovalCandidate = {
  expectedResults: readonly { authority: string }[];
  dslValid?: boolean;
  browserDslValid?: boolean;
  openQuestions: readonly string[];
  steps: readonly { action?: unknown; sideEffect: string; cleanup?: { declared: boolean }; [key: string]: unknown }[];
  effectSteps?: readonly { sideEffect: string; cleanup?: { declared: boolean } }[];
};
export type ApprovalDecision = {
  approved: boolean;
  mode: "AUTO_APPROVED" | "HUMAN_REVIEW";
  reasons: string[];
};

export function evaluateApproval(
  candidate: ApprovalCandidate,
  policy: ApprovalPolicy,
  environment: ApprovalEnvironment,
): ApprovalDecision {
  if (policy.mode !== "auto-approve-safe") {
    return { approved: false, mode: "HUMAN_REVIEW", reasons: ["policy-requires-human-review"] };
  }
  const reasons: string[] = [];
  if (environment.classification === "production") reasons.push("production-target");
  if (candidate.expectedResults.length === 0 || candidate.expectedResults.some((result) => result.authority !== "AUTHORITATIVE")) {
    reasons.push("non-authoritative-assertion");
  }
  if (candidate.dslValid === false || candidate.browserDslValid === false || candidate.steps.some((step) => !validatePlanningAction(step.action).valid)) reasons.push("invalid-dsl");
  if (candidate.openQuestions.length > 0) reasons.push("open-questions");
  if ([...candidate.steps, ...(candidate.effectSteps ?? [])].some((step) => step.sideEffect !== "none" && (step.sideEffect !== "reversible" || step.cleanup?.declared !== true))) {
    reasons.push("unsafe-side-effect");
  }
  return reasons.length === 0
    ? { approved: true, mode: "AUTO_APPROVED", reasons: [] }
    : { approved: false, mode: "HUMAN_REVIEW", reasons };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export function deriveTestPlanApproval(input: {
  plan: Readonly<Record<string, unknown>>;
  requirementAnalyses: readonly Readonly<Record<string, unknown>>[];
  environment: ApprovalEnvironment;
}): ApprovalDecision {
  const policy = input.plan.approvalPolicy;
  const testCases = input.plan.testCases;
  if (!record(policy) || (policy.mode !== "auto-approve-safe" && policy.mode !== "human-review") || !Array.isArray(testCases)) throw new Error("Test plan policy is invalid");
  const requirements = new Map<string, string[]>();
  for (const analysis of input.requirementAnalyses) {
    const statements = analysis.statements;
    if (!Array.isArray(statements)) continue;
    for (const statement of statements) {
      if (!record(statement) || typeof statement.requirementId !== "string" || typeof statement.authority !== "string") continue;
      requirements.set(statement.requirementId, [...(requirements.get(statement.requirementId) ?? []), statement.authority]);
    }
  }
  const expectedResults: { authority: string }[] = [];
  const openQuestions: string[] = [];
  const steps: { action?: unknown; sideEffect: string; cleanup?: { declared: boolean } }[] = [];
  const effectSteps: { sideEffect: string; cleanup?: { declared: boolean } }[] = [];
  let browserDslValid = true;
  for (const testCase of testCases) {
    if (!record(testCase) || !Array.isArray(testCase.expectedResults) || !Array.isArray(testCase.steps) || !Array.isArray(testCase.openQuestions)) throw new Error("Test plan test case is invalid");
    for (const expected of testCase.expectedResults) {
      if (!record(expected) || typeof expected.requirementId !== "string") throw new Error("Test plan expected result is invalid");
      const matches = requirements.get(expected.requirementId) ?? [];
      if (matches.length !== 1) throw new Error("Test plan has an orphan or ambiguous expected result requirement");
      if (expected.authority !== matches[0]) throw new Error("Test plan expected authority does not match its registered requirement");
      expectedResults.push({ authority: matches[0] ?? "ASSUMED" });
    }
    openQuestions.push(...testCase.openQuestions.filter((question): question is string => typeof question === "string"));
    for (const step of testCase.steps) steps.push(record(step) ? {
      action: step.action, sideEffect: typeof step.sideEffect === "string" ? step.sideEffect : "",
      ...(record(step.cleanup) && typeof step.cleanup.declared === "boolean" ? { cleanup: { declared: step.cleanup.declared } } : {}),
    } : { sideEffect: "" });
    if (testCase.browserExecution === undefined) continue;
    const execution = testCase.browserExecution;
    if (!record(execution) || typeof execution.revisionId !== "string" || typeof execution.instanceId !== "string" || !record(execution.browserDsl) || typeof execution.browserDslFingerprint !== "string") throw new Error("Test plan browser execution binding is invalid");
    if (sha256Fingerprint(execution.browserDsl) !== execution.browserDslFingerprint || !validateBrowserTestDsl(execution.browserDsl).valid) browserDslValid = false;
    const browserSteps = execution.browserDsl.steps;
    if (!Array.isArray(browserSteps)) browserDslValid = false;
    else for (const step of browserSteps) effectSteps.push(record(step) ? { sideEffect: typeof step.sideEffect === "string" ? step.sideEffect : "" } : { sideEffect: "" });
  }
  return evaluateApproval({ expectedResults, openQuestions, steps, effectSteps, browserDslValid }, policy as ApprovalPolicy, input.environment);
}
