import type { RequirementAuthority } from "./authority.js";

export type CoverageObligation = {
  obligationId: string;
  requirementId: string;
  role: string;
  behavior: string;
  browser: string;
  viewport: { width: number; height: number };
  accessibilityMethod?: string;
  risk: string;
  required: boolean;
  outcome: string;
};

export type CoverageAttempt = {
  attemptId: string;
  status: string;
  authority?: RequirementAuthority;
  expectedResultAuthority?: RequirementAuthority;
  requirementAuthority?: RequirementAuthority;
  obligationIds: readonly string[];
};

export type CoverageEvaluation = {
  complete: boolean;
  satisfied: string[];
  missing: string[];
  qualifyingAttemptIds: string[];
};

function attemptAuthority(attempt: CoverageAttempt): RequirementAuthority | undefined {
  return attempt.authority ?? attempt.expectedResultAuthority ?? attempt.requirementAuthority;
}

export function evaluateCoverage(
  obligations: readonly CoverageObligation[],
  attempts: readonly CoverageAttempt[],
): CoverageEvaluation {
  const satisfied = new Set<string>();
  const qualifyingAttemptIds = new Set<string>();
  const obligationIds = new Set(obligations.map((obligation) => obligation.obligationId));
  for (const attempt of attempts) {
    if (attempt.status !== "PASSED" || attemptAuthority(attempt) !== "AUTHORITATIVE") continue;
    const addressed = attempt.obligationIds.filter((id) => obligationIds.has(id));
    if (addressed.length === 0) continue;
    addressed.forEach((id) => satisfied.add(id));
    qualifyingAttemptIds.add(attempt.attemptId);
  }
  const missing = obligations.filter((obligation) => obligation.required && !satisfied.has(obligation.obligationId))
    .map((obligation) => obligation.obligationId);
  return {
    complete: missing.length === 0,
    satisfied: obligations.filter((obligation) => satisfied.has(obligation.obligationId)).map((obligation) => obligation.obligationId),
    missing,
    qualifyingAttemptIds: [...qualifyingAttemptIds],
  };
}
