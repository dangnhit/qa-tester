export type CoverageObligation = {
  obligationId: string;
  requirementId: string;
  role: string;
  behavior: string;
  browser: string;
  viewport: { width: number; height: number };
  accessibilityMethod?: string | undefined;
  risk: string;
  required: boolean;
  outcome: string;
};

export type CoverageAttempt = {
  attemptId: string;
  status: string;
  authority?: string;
  expectedResultAuthority?: string;
  requirementAuthority?: string;
  authorityProvenance?: string;
  obligationIds: readonly string[];
  requirementId: string;
  role: string;
  behavior: string;
  browser: string;
  viewport: { width: number; height: number };
  accessibilityMethod?: string | undefined;
  risk: string;
  outcome: string;
};

export type CoverageEvaluation = {
  complete: boolean;
  satisfied: string[];
  missing: string[];
  qualifyingAttemptIds: string[];
};

export type VerifiedCoverageContext = {
  authoritativeRequirementIds: readonly string[];
  verifiedAttemptIds: readonly string[];
};

function matchesObligation(attempt: CoverageAttempt, obligation: CoverageObligation): boolean {
  return attempt.requirementId === obligation.requirementId
    && attempt.role === obligation.role
    && attempt.behavior === obligation.behavior
    && attempt.browser === obligation.browser
    && attempt.viewport.width === obligation.viewport.width
    && attempt.viewport.height === obligation.viewport.height
    && attempt.accessibilityMethod === obligation.accessibilityMethod
    && attempt.risk === obligation.risk
    && attempt.outcome === obligation.outcome;
}

export function evaluateCoverage(
  obligations: readonly CoverageObligation[],
  attempts: readonly CoverageAttempt[],
  verification: VerifiedCoverageContext,
): CoverageEvaluation {
  const satisfied = new Set<string>();
  const qualifyingAttemptIds = new Set<string>();
  const obligationIds = new Set(obligations.map((obligation) => obligation.obligationId));
  for (const attempt of attempts) {
    if (
      attempt.status !== "PASSED"
      || !verification.verifiedAttemptIds.includes(attempt.attemptId)
    ) continue;
    const addressed = attempt.obligationIds.filter((id) => {
      const obligation = obligations.find((candidate) => candidate.obligationId === id);
      return obligationIds.has(id)
        && obligation !== undefined
        && verification.authoritativeRequirementIds.includes(obligation.requirementId)
        && matchesObligation(attempt, obligation);
    });
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
