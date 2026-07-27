/**
 * The Execution Surfaces an obligation may declare (CONTEXT.md:443). The QA Runtime executes only
 * `browser` itself and reaches every other surface through a Runtime-Observed Execution
 * (CONTEXT.md:444) — so the rest are authorable but, until a producer exists, never satisfied. That
 * is deliberate: an uncovered surface must stay EXPLICITLY UNMET rather than absent (CONTEXT.md:445).
 *
 * Mirrors `executionSurface`'s enum in shared/schemas/coverage-obligation.schema.json.
 */
export const executionSurfaces = ["browser", "api", "unit", "integration", "performance", "security", "manual"] as const;

export type ExecutionSurface = (typeof executionSurfaces)[number];

/** Narrows an untrusted artifact field to a known surface; `undefined` means "not a surface at all". */
export function asExecutionSurface(value: unknown): ExecutionSurface | undefined {
  return (executionSurfaces as readonly unknown[]).includes(value) ? value as ExecutionSurface : undefined;
}

export type CoverageObligation = {
  obligationId: string;
  requirementId: string;
  executionSurface: ExecutionSurface;
  role: string;
  behavior: string;
  /** Browser-surface only. Absent on every other surface — the schema forbids it there. */
  browser?: string | undefined;
  /** Browser-surface only. Absent on every other surface — the schema forbids it there. */
  viewport?: { width: number; height: number } | undefined;
  accessibilityMethod?: string | undefined;
  risk: string;
  required: boolean;
  outcome: string;
};

export type CoverageAttempt = {
  // Shared namespace across both lanes: readers populate this from a lane-1 `test-result`'s `attemptId`
  // AND from a lane-2 `test-result-batch` entry's `entryId`, with no cross-uniqueness check between the
  // two. Harmless today because both readers only aggregate qualifying ids into a `Set`, but whoever
  // next resolves a `qualifyingAttemptId` back to a source artifact must know a collision between an
  // attempt id and an entry id is possible.
  attemptId: string;
  status: string;
  requirementId: string;
  /**
   * DERIVED, never declared. Both readers set this from how the claim was produced, not from a label
   * on the test case: per CONTEXT.md:444 the runtime executes the browser surface itself, so a lane-1
   * `test-result` is `browser` by construction. A lane-2 `test-result-batch` entry derives the same
   * value, because the only dimensions any attempt can carry come from `test-case.coverage`, which is
   * browser-shaped by schema (`browser` + `viewport` are both required there). Deliberately NOT added
   * to `test-case.schema.json`: a second declared label would only create a drift surface.
   *
   * Phase 7 obligation: `test-result-batch` is the Runtime-Observed Execution artifact (CONTEXT.md:444)
   * — precisely how a non-browser surface is meant to be reached. If `test-case.coverage` is ever
   * relaxed to allow non-browser cases, this field must stop being derived from it: the surface signal
   * has to come from the observed-execution record itself. Until that change lands, the two hardcoded
   * `"browser"` literals at the derivation sites (`release-gate.ts`'s `asAttempt`, `evaluate-workspace-
   * coverage.ts`'s `dimensions()`) would become live mis-credit sites — a non-browser batch entry
   * stamped `browser` could satisfy a browser obligation it never ran.
   */
  executionSurface: ExecutionSurface;
  role: string;
  behavior: string;
  /**
   * OBSERVED, never declared (CONTEXT.md:442): the engine the QA Runtime saw driving this attempt,
   * carried on the claim itself (`test-result.observedEngine`, or a `test-result-batch` entry's). It is
   * named differently from `CoverageObligation.browser` on purpose — that one is a DECLARATION, and the
   * whole defect this field exists to kill was comparing two declarations to each other while the
   * execution went unconsulted. There is deliberately no declared-engine field on an attempt, so no
   * reader can reach for one; both readers drop or reject a claim that carries no observed engine
   * rather than falling back to `test-case.coverage.browser`.
   *
   * Browser-surface only, like `viewport`: `undefined` on every other surface, where it is not compared.
   */
  observedEngine?: string | undefined;
  /**
   * DECLARED, still: unlike the engine, the runtime does not measure the viewport it ends up with — it
   * SETS it from `test-case.coverage.viewport` (`createBrowserAttemptSession`), so the declaration is
   * causally upstream of the geometry rather than an independent claim about it. That makes it a weaker
   * check than `observedEngine`, not a vacuous one, and closing the gap (reading `page.viewportSize()`)
   * is deliberately out of this task's scope. Until then this half of CONTEXT.md:441 rests on the
   * runtime applying what it was told.
   */
  viewport?: { width: number; height: number } | undefined;
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

/**
 * Browser engine and viewport are dimensions OF the browser surface — they describe geometry the QA
 * Runtime actually drove. They participate only when the obligation declares that surface. On any
 * other surface the schema forbids them outright, so comparing them would compare two absences and
 * silently widen the match; the surface equality check above is what discriminates there.
 *
 * The engine comparison is OBSERVED-against-DECLARED (CONTEXT.md:442): the attempt contributes the
 * engine that ran, the obligation the engine that was required. An obligation naming an engine the
 * runtime never launches is therefore correctly unsatisfiable — that is CONTEXT.md:441 working, not a
 * regression: a missing Browser Matrix member is never satisfied by another engine.
 */
function matchesBrowserDimensions(attempt: CoverageAttempt, obligation: CoverageObligation): boolean {
  if (obligation.executionSurface !== "browser") return true;
  return attempt.observedEngine !== undefined && attempt.observedEngine === obligation.browser
    && attempt.viewport !== undefined && obligation.viewport !== undefined
    && attempt.viewport.width === obligation.viewport.width
    && attempt.viewport.height === obligation.viewport.height;
}

function matchesObligation(attempt: CoverageAttempt, obligation: CoverageObligation): boolean {
  // An attempt may only address an obligation on the surface the attempt actually has: a browser run
  // is not evidence about an API, a unit suite, or a manual review.
  return attempt.executionSurface === obligation.executionSurface
    && matchesBrowserDimensions(attempt, obligation)
    && attempt.requirementId === obligation.requirementId
    && attempt.role === obligation.role
    && attempt.behavior === obligation.behavior
    && attempt.accessibilityMethod === obligation.accessibilityMethod
    && attempt.risk === obligation.risk
    && attempt.outcome === obligation.outcome;
}

/**
 * Deterministic pure façade for already-resolved canonical records. It accepts
 * no authority, provenance, verification-ID, or workspace inputs. Runtime
 * authority resolution belongs exclusively to evaluateWorkspaceCoverage.
 */
export function evaluateCoverage(
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

/** @deprecated Use evaluateCoverage; this alias preserves resolved-record callers. */
export const evaluateResolvedCoverage = evaluateCoverage;
