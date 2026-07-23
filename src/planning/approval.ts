export type ApprovalPolicy = { mode: "auto-approve-safe" | "human-review" };
export type ApprovalEnvironment = { classification: "local" | "test" | "staging" | "production" };
export type ApprovalCandidate = {
  expectedResults: readonly { authority: string }[];
  dslValid: boolean;
  openQuestions: readonly string[];
  steps: readonly { sideEffect: string; cleanup?: { declared: boolean }; [key: string]: unknown }[];
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
  if (!candidate.dslValid) reasons.push("invalid-dsl");
  if (candidate.openQuestions.length > 0) reasons.push("open-questions");
  if (candidate.steps.some((step) => step.sideEffect !== "none" && (step.sideEffect !== "reversible" || step.cleanup?.declared !== true))) {
    reasons.push("unsafe-side-effect");
  }
  return reasons.length === 0
    ? { approved: true, mode: "AUTO_APPROVED", reasons: [] }
    : { approved: false, mode: "HUMAN_REVIEW", reasons };
}
