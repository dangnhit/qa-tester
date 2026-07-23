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
  requirementId: string;
  role: string;
  behavior: string;
  browser: string;
  viewport: { width: number; height: number };
  accessibilityMethod?: string | undefined;
  risk: string;
  outcome: string;
};

/** A coverage obligation after its requirement-analysis provenance has been resolved. */
export type ResolvedCoverageObligation = CoverageObligation & {
  authoritativeRequirement: boolean;
};

export type CoverageEvaluation = {
  complete: boolean;
  satisfied: string[];
  missing: string[];
  qualifyingAttemptIds: string[];
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

/**
 * Pure downstream evaluator. Inputs must already be resolved from immutable
 * workspace records; it deliberately accepts no caller-supplied verification IDs.
 */
export function evaluateResolvedCoverage(
  obligations: readonly ResolvedCoverageObligation[],
  attempts: readonly CoverageAttempt[],
): CoverageEvaluation {
  const satisfied = new Set<string>();
  const qualifyingAttemptIds = new Set<string>();
  const obligationIds = new Set(obligations.map((obligation) => obligation.obligationId));
  for (const attempt of attempts) {
    if (
      attempt.status !== "PASSED"
    ) continue;
    const addressed = obligations.filter((obligation) =>
      obligationIds.has(obligation.obligationId)
      && obligation.authoritativeRequirement
      && matchesObligation(attempt, obligation)
    ).map((obligation) => obligation.obligationId);
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
