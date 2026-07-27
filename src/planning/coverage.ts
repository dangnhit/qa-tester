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
 * audit record is a claim nothing can check.
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
   * The declaration that makes this an ACCESSIBILITY OBLIGATION. `undefined` (projected from the
   * schema's `null`) means it is not one at all — the common case — and is the ONLY value an attempt
   * can address. Any other value routes the obligation to the attestation path, where a declared
   * label can never satisfy itself (CONTEXT.md:439).
   *
   * Deliberately still `string`, not `AccessibilityMethod`, even though the schema is an enum, and
   * now for a sharper reason than before: narrowing would need either an unchecked cast (a lie) or a
   * runtime narrow that maps an unrecognised label to `undefined` — and `undefined` is exactly the
   * value that re-opens the attempt path. A tampered or hand-authored `"manual-keyboard"` would then
   * be CREDITED by a passing browser attempt. The wide type is what keeps every non-`undefined`
   * label unsatisfiable-by-attempt, so it stays as wide as the readers actually are.
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
  // There is deliberately NO `accessibilityMethod` here, for the same reason there is no declared
  // engine (CONTEXT.md:442, `observedEngine` above). It used to be read straight off
  // `test-case.coverage.accessibilityMethod` and compared to the obligation's, which is one declared
  // label matching another — exactly what CONTEXT.md:439 forbids. An attempt now cannot address an
  // Accessibility Obligation at all (see `matchesObligation`), so the slot has no reader left, and
  // leaving it would only let a future one reach for it. `test-case.coverage.accessibilityMethod`
  // still exists and is still validated by the schema; both readers now drop it on the floor.
  risk: string;
  outcome: string;
};

/** A coverage obligation after its requirement-analysis provenance AND its Human Attestation have
 *  been resolved from the workspace. */
export type ResolvedCoverageObligation = CoverageObligation & {
  authoritativeRequirement: boolean;
  /**
   * A registered, valid `human-attestation` names THIS obligation artifact's exact immutable bytes.
   *
   * A boolean per obligation rather than a list of attestations passed alongside `evaluateCoverage`,
   * because that is all this layer needs and because the join belongs to the readers: they hold the
   * artifact RECORD, so they can match `attestation.obligationSha256` against the obligation's own
   * checksum. A list reaching `evaluateCoverage` would have to be keyed by `obligationId` — the only
   * identity this layer has — and that id is NOT unique across a workspace (`coverageObligationRule`
   * never checks it), so one attestation could credit an unrelated obligation that happens to share
   * an id. Joining in the reader keeps the byte-exact binding `obligationSha256` exists for.
   *
   * What this field does NOT re-verify, because Task 34's semantic rule already guarantees it for
   * any attestation that validates: that it binds exactly one registered `coverage-obligation` by
   * relationship, that its checksum matches, and that its `method` equals the obligation's declared
   * `accessibilityMethod`. Its schema additionally admits only the three MANUAL methods, so `true`
   * here can only ever mean "a person carried out the manual evaluation this obligation names".
   * Every live entry point feeds these readers artifacts that have passed that validation
   * (`readRegisteredArtifacts` throws on any diagnostic and returns only valid records; the
   * `release-gate` rule re-derives from the cascade-sensitive valid pool).
   *
   * A boolean also settles what TWO attestations for one obligation mean, which stops being inert the
   * moment attestations are load-bearing: nothing. Credit is set membership, so N attestations grant
   * exactly what one does, and `human-attestation` carries no verdict field — no `passed`, no
   * `blocked` — so a second attestation cannot contradict the first. Both say the same kind of thing
   * ("I carried out this evaluation"), and a second person saying it does not weaken the first; both
   * artifacts stay immutable and independently auditable. Forbidding duplicates would need a
   * uniqueness clause in a rule this task deliberately does not touch, and would buy nothing. What
   * WOULD make duplicates load-bearing is a negative attestation or a quorum policy; neither exists,
   * and whoever adds one must revisit this line before doing so.
   */
  humanAttested: boolean;
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
  // An Accessibility Obligation is never addressed by an attempt — CONTEXT.md:438 says "only by",
  // and a passing browser attempt is evidence about a browser interaction, not about a screen-reader
  // or keyboard evaluation. This clause replaces `attempt.accessibilityMethod ===
  // obligation.accessibilityMethod`, which credited an obligation whenever a test case declared the
  // same label back at it (CONTEXT.md:439). Whether the obligation is satisfiable at all is decided
  // in `evaluateCoverage` below; here it is simply out of the attempt path.
  if (obligation.accessibilityMethod !== undefined) return false;
  // An attempt may only address an obligation on the surface the attempt actually has: a browser run
  // is not evidence about an API, a unit suite, or a manual review.
  return attempt.executionSurface === obligation.executionSurface
    && matchesBrowserDimensions(attempt, obligation)
    && attempt.requirementId === obligation.requirementId
    && attempt.role === obligation.role
    && attempt.behavior === obligation.behavior
    && attempt.risk === obligation.risk
    && attempt.outcome === obligation.outcome;
}

/**
 * The satisfier of an Accessibility Obligation (CONTEXT.md:438) — the whole of it.
 *
 * A MANUAL method (`keyboard`, `screen-reader`, `cognitive-manual`) is satisfied by a Human
 * Attestation bound to this obligation's exact bytes, and by nothing else.
 *
 * `automated-analysis` is satisfiable by NOTHING today, and falls out of this expression rather than
 * needing a clause: no `human-attestation` can name it (its schema admits only the manual three, and
 * its rule demands equality with the obligation's declared method), so `humanAttested` can never be
 * true for one. What would satisfy it is a machine-produced artifact from an accessibility scanner
 * run against the product — an axe/Lighthouse-style analysis registered as its own evidence-bearing
 * artifact type, carrying the ruleset, its version, and the violations found. No such scanner, and
 * no such artifact type, exists in this repo; inventing a stand-in would be the same
 * credit-without-evidence defect in a new costume. Until one ships, such an obligation is EXPLICITLY
 * UNMET, exactly like an Execution Surface no executor covers (CONTEXT.md:445).
 *
 * An unrecognised label — reachable because `accessibilityMethod` is deliberately typed `string` —
 * is unsatisfiable for the same reason, and that is the correct fail-closed answer.
 */
function satisfiedByAttestation(obligation: ResolvedCoverageObligation): boolean {
  return obligation.accessibilityMethod !== undefined && obligation.humanAttested;
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
  // Attested Accessibility Obligations first, and separately: they are satisfied by an artifact, not
  // by an attempt, so they contribute NOTHING to `qualifyingAttemptIds` below. There is no attempt to
  // report — a Human Attestation records an evaluation a machine never performed — and that field's
  // id namespace already mixes `test-result.attemptId` with `test-result-batch` entry ids, so
  // stuffing an attestation id into it would make an already-ambiguous key unresolvable. The
  // authority gate is the same one the attempt path applies: it is about the REQUIREMENT, not about
  // how the requirement was evidenced.
  const satisfied = new Set(obligations
    .filter((obligation) => obligation.authoritativeRequirement && satisfiedByAttestation(obligation))
    .map((obligation) => obligation.obligationId));
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
