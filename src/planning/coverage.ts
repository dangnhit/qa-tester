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

/**
 * The accessibility evaluation methods an Accessibility Obligation may name. These are exactly
 * CONTEXT.md:437's four categories — "automated analysis, keyboard evaluation, screen-reader
 * evaluation, and cognitive/manual review" — and nothing else: a free-form label in a checksummed
 * audit record is a claim nothing can check, and until Task 35 lands, label equality is what credits
 * the obligation (CONTEXT.md:439 is the rule that forbids exactly that).
 *
 * `null`, deliberately NOT a member here, is how an obligation says it names no accessibility method
 * at all — the common case. It stays a different JSON type rather than a fifth enum member so that
 * "no accessibility obligation" can never be mistaken for a declared method that matches itself.
 *
 * Mirrors `accessibilityMethod`'s enum in shared/schemas/coverage-obligation.schema.json and the
 * nested `coverage.accessibilityMethod` in shared/schemas/test-case.schema.json.
 */
export const accessibilityMethods = ["automated-analysis", "keyboard", "screen-reader", "cognitive-manual"] as const;

export type AccessibilityMethod = (typeof accessibilityMethods)[number];

/**
 * The subset a person can carry out. CONTEXT.md:438: an automated Accessibility Obligation is
 * satisfied only by a machine-produced artifact, and a MANUAL one only by a Human Attestation — so
 * an attestation claiming `automated-analysis` is a category error, and `human-attestation.schema.
 * json`'s `method` enum is this list rather than the full one.
 */
export const manualAccessibilityMethods = ["keyboard", "screen-reader", "cognitive-manual"] as const satisfies readonly AccessibilityMethod[];

export type ManualAccessibilityMethod = (typeof manualAccessibilityMethods)[number];

/** Narrows an untrusted CLI argument to a method a Human Attestation may claim. */
export function isManualAccessibilityMethod(value: unknown): value is ManualAccessibilityMethod {
  return (manualAccessibilityMethods as readonly unknown[]).includes(value);
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
  /**
   * Deliberately still `string`, not `AccessibilityMethod`, even though the schema is now an enum.
   * Both readers project this with `string(value.accessibilityMethod)`, which maps `null` to
   * `undefined` and passes any other string through. Narrowing the type here would need either an
   * unchecked cast (a lie) or a runtime narrow that silently drops an unrecognised label — and
   * dropping it would change what `matchesObligation` credits. What an accessibility obligation is
   * satisfied by is Task 35's decision, so this stays as wide as the reader actually is.
   */
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
   *
   * That argument holds only for lane 1: the DSL's action union (`shared/schemas/browser-test-dsl.
   * schema.json`) has no resize or emulation action, so nothing can change the viewport after
   * `createBrowserAttemptSession` sets it from the declaration. Phase 7 obligation: a `test-result-batch`
   * entry carries no viewport at all, so the same two derivation sites (`release-gate.ts`'s `asAttempt`,
   * `evaluate-workspace-coverage.ts`'s `dimensions()`) would fall back to `test-case.coverage.viewport`
   * with no causal link whatsoever to whatever produced the entry — the exact two-declarations-agreeing
   * shape `observedEngine` exists to kill, just not yet closed here. It is not live today because no batch
   * producer exists; it becomes live the moment Phase 7 lands one, so this viewport follow-up must be
   * sequenced before or alongside that producer, not merely sometime after it.
   */
  viewport?: { width: number; height: number } | undefined;
  /**
   * DECLARED, and the last declared-value slot of the kind Task 33 removed for the engine: this is
   * read straight off `test-case.coverage.accessibilityMethod`, so `matchesObligation` comparing it to
   * the obligation's is one declared label matching another — exactly what CONTEXT.md:439 forbids.
   * Constraining both sides to an enum (Task 34) narrows what those labels may say but does not fix
   * that; removing this field, and making a manual obligation require a `human-attestation` instead,
   * is Task 35's job. Same `string`-not-`AccessibilityMethod` reasoning as the obligation's field.
   */
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
