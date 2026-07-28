import { describe, expect, it } from "vitest";

import { evaluateCoverage } from "../../src/planning/coverage.js";

const obligation = {
  obligationId: "COV-SAVE-CHROMIUM",
  requirementId: "REQ-SAVE",
  executionSurface: "browser" as const,
  role: "member",
  behavior: "save profile",
  browser: "chromium",
  viewport: { width: 1440, height: 900 },
  accessibilityMethod: undefined,
  risk: "high",
  required: true,
  outcome: "confirmation shown",
  authoritativeRequirement: true,
  // Not an Accessibility Obligation (`accessibilityMethod: undefined`), so nothing attests to it.
  humanAttested: false,
};

function matchingAttempt(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: "ATTEMPT-PASS",
    status: "PASSED",
    authoritativeRequirement: true,
    requirementId: obligation.requirementId,
    // Derived, never declared: the QA Runtime executes only the browser surface (CONTEXT.md:444).
    executionSurface: "browser" as const,
    role: obligation.role,
    behavior: obligation.behavior,
    // OBSERVED, not declared (CONTEXT.md:442). The obligation's `browser` beside it is a DECLARATION;
    // the two field names differ on purpose, so a reader can never confuse which side is which.
    observedEngine: obligation.browser,
    viewport: obligation.viewport,
    risk: obligation.risk,
    outcome: obligation.outcome,
    ...overrides,
  };
}

describe("evaluateCoverage", () => {
  it("provides the deterministic public façade for already-resolved canonical records", () => {
    const evaluation = evaluateCoverage([obligation], [
      matchingAttempt({ attemptId: "ATTEMPT-FAILED", status: "FAILED" }),
      matchingAttempt(),
    ]);

    expect(evaluation.satisfied).toEqual([obligation.obligationId]);
    expect(evaluation.missing).toEqual([]);
    expect(evaluation.qualifyingAttemptIds).toEqual(["ATTEMPT-PASS"]);
  });

  it("reports a required obligation as missing when only non-authoritative passing attempts exist", () => {
    const evaluation = evaluateCoverage([{ ...obligation, authoritativeRequirement: false }], [
      matchingAttempt({ attemptId: "ATTEMPT-ASSUMED" }),
    ]);

    expect(evaluation.satisfied).toEqual([]);
    expect(evaluation.missing).toEqual([obligation.obligationId]);
    expect(evaluation.complete).toBe(false);
  });

  // "accessibility method" was a row here until CONTEXT.md:439 was enforced. It cannot be one now:
  // an attempt has no `accessibilityMethod` to mismatch WITH, because it cannot address an
  // Accessibility Obligation at all. Both halves of what replaced it — the label buying no credit,
  // and the label vetoing none — are pinned in "evaluateCoverage — accessibility obligations".
  it.each([
    ["requirement", { requirementId: "REQ-OTHER" }],
    ["role", { role: "admin" }],
    ["behavior", { behavior: "delete profile" }],
    ["observed engine", { observedEngine: "webkit" }],
    ["viewport", { viewport: { width: 390, height: 844 } }],
    ["risk", { risk: "low" }],
    ["outcome", { outcome: "redirected" }],
  ])("does not satisfy an obligation with a mismatched %s", (_dimension, mismatch) => {
    const evaluation = evaluateCoverage([obligation], [matchingAttempt(mismatch)]);

    expect(evaluation.satisfied).toEqual([]);
    expect(evaluation.missing).toEqual([obligation.obligationId]);
  });

  /** CONTEXT.md:442: a Browser Matrix member is credited from the engine the QA Runtime OBSERVED,
   *  never from the engine a test case declared. An attempt therefore has no declared-engine field at
   *  all. This pins the matcher against a `browser` label smuggled onto an attempt record — the exact
   *  field it used to compare, and the only way this unit could regress to comparing a declaration. */
  it("never falls back to a declared browser label smuggled onto an attempt", () => {
    const evaluation = evaluateCoverage([obligation], [matchingAttempt({ observedEngine: "firefox", browser: obligation.browser })]);

    expect(evaluation.satisfied).toEqual([]);
    expect(evaluation.missing).toEqual([obligation.obligationId]);
    expect(evaluation.qualifyingAttemptIds).toEqual([]);
  });

  it("credits an obligation whose declared engine the attempt actually observed", () => {
    const firefoxObligation = { ...obligation, browser: "firefox" };

    const evaluation = evaluateCoverage([firefoxObligation], [matchingAttempt({ observedEngine: "firefox", browser: "chromium" })]);

    expect(evaluation.satisfied).toEqual([firefoxObligation.obligationId]);
    expect(evaluation.qualifyingAttemptIds).toEqual(["ATTEMPT-PASS"]);
  });
});

/**
 * CONTEXT.md:438 — "An automated Accessibility Obligation is satisfied only by a machine-produced
 * artifact, and a manual one only by a Human Attestation." CONTEXT.md:439 — "A declared evaluation
 * method never satisfies an Accessibility Obligation by matching its own label."
 *
 * Before this change `matchesObligation` compared `attempt.accessibilityMethod ===
 * obligation.accessibilityMethod`: two DECLARED labels agreeing with each other, with no screen
 * reader, no human, and no artifact anywhere in the run. The kill test below is that defect; the one
 * after it is the converse, and credits the obligation with no passing attempt in the set at all —
 * so the attestation is demonstrably doing the work rather than merely accompanying an attempt.
 */
describe("evaluateCoverage — accessibility obligations", () => {
  /** A MANUAL Accessibility Obligation: the only thing that can satisfy it is a Human Attestation. */
  const screenReader = { ...obligation, obligationId: "COV-SAVE-SCREEN-READER", accessibilityMethod: "screen-reader" };

  it("does not credit a screen-reader obligation from a passing attempt declaring screen-reader, with no attestation", () => {
    // The attempt agrees on EVERY other dimension and carries the very label the old matcher
    // compared — smuggled on exactly as the declared-engine test smuggles `browser`, because the
    // field no longer exists on `CoverageAttempt`. Nothing in this evaluation is a screen reader,
    // a human, or an artifact: the obligation must stay unmet.
    const evaluation = evaluateCoverage([screenReader], [matchingAttempt({ accessibilityMethod: "screen-reader" })]);

    expect(evaluation.satisfied).toEqual([]);
    expect(evaluation.missing).toEqual([screenReader.obligationId]);
    expect(evaluation.qualifyingAttemptIds).toEqual([]);
    expect(evaluation.complete).toBe(false);
  });

  it("credits that same obligation from its Human Attestation with no passing attempt at all", () => {
    const evaluation = evaluateCoverage([{ ...screenReader, humanAttested: true }], []);

    expect(evaluation.satisfied).toEqual([screenReader.obligationId]);
    expect(evaluation.missing).toEqual([]);
    expect(evaluation.complete).toBe(true);
  });

  it("credits an attested obligation without qualifying the attempt that happened to run beside it", () => {
    // An attestation contains no attempt, so no attempt id may be reported as qualifying for it.
    const evaluation = evaluateCoverage([{ ...screenReader, humanAttested: true }], [matchingAttempt({ accessibilityMethod: "screen-reader" })]);

    expect(evaluation.satisfied).toEqual([screenReader.obligationId]);
    expect(evaluation.qualifyingAttemptIds).toEqual([]);
  });

  it("does not credit an attested obligation whose requirement is not authoritative", () => {
    // The authority gate is about the REQUIREMENT, not about how it was evidenced, so it applies to
    // the attestation path exactly as it applies to the attempt path.
    const evaluation = evaluateCoverage([{ ...screenReader, humanAttested: true, authoritativeRequirement: false }], []);

    expect(evaluation.satisfied).toEqual([]);
    expect(evaluation.missing).toEqual([screenReader.obligationId]);
  });

  it("does not let an attestation for one obligation satisfy another declaring the same method", () => {
    const attested = { ...screenReader, obligationId: "COV-OTHER-SCREEN-READER", behavior: "delete profile", humanAttested: true };

    const evaluation = evaluateCoverage([screenReader, attested], [matchingAttempt({ accessibilityMethod: "screen-reader" })]);

    expect(evaluation.satisfied).toEqual([attested.obligationId]);
    expect(evaluation.missing).toEqual([screenReader.obligationId]);
  });

  /** `automated-analysis` is satisfiable by nothing in this repo today — there is no accessibility
   *  scanner, no dependency, and no evidence kind for a scan result — so it must be EXPLICITLY
   *  UNMET, exactly like Task 32's unexecutable surfaces. An unrecognised label is treated the same
   *  way and for a stronger reason: no Human Attestation can ever name it (the attestation schema
   *  admits only the three manual members and its rule demands equality with the obligation's
   *  declared method), so nothing can satisfy it either. */
  it.each(["automated-analysis", "manual-keyboard"])("never credits an obligation declaring %s from an attempt declaring the same", (method) => {
    const evaluation = evaluateCoverage([{ ...screenReader, accessibilityMethod: method }], [matchingAttempt({ accessibilityMethod: method })]);

    expect(evaluation.satisfied).toEqual([]);
    expect(evaluation.missing).toEqual([screenReader.obligationId]);
    expect(evaluation.qualifyingAttemptIds).toEqual([]);
  });

  /** The no-regression pin for the common case: `accessibilityMethod: null` (projected to
   *  `undefined`) is NOT an Accessibility Obligation at all, and keeps being satisfied by a matching
   *  passing attempt with no attestation anywhere. */
  it("still satisfies a null-method obligation from a passing attempt, with nothing attested", () => {
    const evaluation = evaluateCoverage([obligation], [matchingAttempt()]);

    expect(evaluation.satisfied).toEqual([obligation.obligationId]);
    expect(evaluation.missing).toEqual([]);
    expect(evaluation.qualifyingAttemptIds).toEqual(["ATTEMPT-PASS"]);
  });

  it("still satisfies a null-method obligation when the test case declares a method of its own", () => {
    // The mirror of the kill test, and the reason the attempt's declared slot is gone rather than
    // merely unused: a declared label can no more VETO a credit the run earned than it can BUY one
    // it did not. The obligation asks for no accessibility evaluation, so the label is not a
    // coverage dimension here — it is a fact about the test case that the gate does not consult.
    const evaluation = evaluateCoverage([obligation], [matchingAttempt({ accessibilityMethod: "keyboard" })]);

    expect(evaluation.satisfied).toEqual([obligation.obligationId]);
    expect(evaluation.qualifyingAttemptIds).toEqual(["ATTEMPT-PASS"]);
  });

  /**
   * The `manual` SURFACE and the accessibility METHOD are separate axes, and conflating them put a
   * false credit path into agent-facing documentation once already: `skills/browser-test-executor`
   * claimed a `manual` obligation stays unmet "until a person records a Human Attestation".
   *
   * `satisfiedByAttestation` reads `accessibilityMethod` and never looks at the surface, and
   * `matchesObligation` refuses every obligation carrying a method — so a `manual`-surface obligation
   * with NO method is satisfiable by nothing at all, while one carrying a manual method is satisfiable
   * by attestation for a reason that has nothing to do with its being `manual`.
   */
  it("never credits a manual-surface obligation that declares no accessibility method, attested or not", () => {
    const manualObligation = { ...obligation, obligationId: "COV-SAVE-MANUAL", executionSurface: "manual" as const, browser: undefined, viewport: undefined };

    const unattested = evaluateCoverage([manualObligation], [matchingAttempt()]);
    const attested = evaluateCoverage([{ ...manualObligation, humanAttested: true }], [matchingAttempt()]);

    expect(unattested.missing).toEqual(["COV-SAVE-MANUAL"]);
    expect(attested.missing).toEqual(["COV-SAVE-MANUAL"]);
    expect(attested.satisfied).toEqual([]);
  });

  it("credits an attested manual method on a non-browser surface, because the method decides and the surface does not", () => {
    const apiKeyboard = { ...obligation, obligationId: "COV-SAVE-API-KEYBOARD", executionSurface: "api" as const, browser: undefined, viewport: undefined, accessibilityMethod: "keyboard", humanAttested: true };

    const evaluation = evaluateCoverage([apiKeyboard], []);

    expect(evaluation.satisfied).toEqual(["COV-SAVE-API-KEYBOARD"]);
    expect(evaluation.missing).toEqual([]);
  });

  it("does not credit a null-method obligation from an attestation alone", () => {
    // Defence in depth: no valid attestation can bind an obligation declaring no method (Task 34's
    // rule rejects it), so this record could only arise from a bug. It must still take an attempt.
    const evaluation = evaluateCoverage([{ ...obligation, humanAttested: true }], []);

    expect(evaluation.satisfied).toEqual([]);
    expect(evaluation.missing).toEqual([obligation.obligationId]);
  });
});

/** An obligation declares exactly one Execution Surface (CONTEXT.md:443). The runtime executes the
 *  browser surface itself and reaches `api`, `unit`, `integration`, `performance` and `security`
 *  through a Runtime-Observed Execution (CONTEXT.md:444, lane 2 since Phase 7) — but only when a run
 *  actually observed a spec tagged with that surface. `manual` has no executor in either lane. An
 *  obligation nothing executed must stay EXPLICITLY UNMET rather than quietly vanish (CONTEXT.md:445),
 *  which is surface-independent and is what this block pins. */
describe("evaluateCoverage — execution surfaces", () => {
  /** A required obligation on a non-browser surface: no engine, no geometry, by design. Lane 2 can
   *  produce an `api` entry, so this is no longer a surface NOTHING can cover — but nothing covers it
   *  in these evaluations, which is exactly the state each test below is about. */
  const apiObligation = {
    obligationId: "COV-SAVE-API",
    requirementId: "REQ-SAVE",
    executionSurface: "api" as const,
    role: "member",
    behavior: "save profile",
    accessibilityMethod: undefined,
    risk: "high",
    required: true,
    outcome: "confirmation shown",
    authoritativeRequirement: true,
    humanAttested: false,
  };

  // RENAMED (was "reports a required non-browser obligation as MISSING, never as absent, when nothing
  // executes it"): with zero attempts, matchesObligation is never reached, so this cannot exercise —
  // and never did exercise — anything surface-specific. evaluateCoverage never drops an obligation from
  // the list it is handed; only the resolver (release-gate.ts / evaluate-workspace-coverage.ts) can do
  // that, and the guarantee that a non-browser obligation actually reaches this list, rather than being
  // dropped beforehand, is covered there (release-gate.test.ts's "keeps a required obligation on an
  // unexecutable surface explicitly unmet, never absent", and workspace-coverage.test.ts). What remains
  // true and worth pinning here is the surface-independent baseline this test now names honestly.
  it("reports a required obligation as missing when it has no attempts at all, regardless of surface", () => {
    const evaluation = evaluateCoverage([apiObligation], []);

    expect(evaluation.missing).toEqual([apiObligation.obligationId]);
    expect(evaluation.satisfied).toEqual([]);
    expect(evaluation.complete).toBe(false);
  });

  it("does not let a browser attempt satisfy a non-browser obligation matching on every other dimension", () => {
    // Every OTHER dimension must genuinely agree, including browser + viewport — otherwise this would
    // pass merely because `attempt.observedEngine !== obligation.browser` ("chromium" vs `undefined`), without
    // the surface check ever being exercised. Smuggling matching geometry on (illegal in a real artifact;
    // the schema forbids it — see "decides on the surface alone" below) is the only way to close that
    // gap in a plain-object unit test.
    const fullyMatchingApiObligation = { ...apiObligation, browser: obligation.browser, viewport: obligation.viewport };

    const evaluation = evaluateCoverage([fullyMatchingApiObligation], [matchingAttempt()]);

    expect(evaluation.satisfied).toEqual([]);
    expect(evaluation.missing).toEqual([apiObligation.obligationId]);
    expect(evaluation.qualifyingAttemptIds).toEqual([]);
  });

  it("evaluates a non-browser obligation without throwing on the viewport it legitimately lacks", () => {
    // A non-browser attempt carries no viewport either, so the unguarded `attempt.viewport.width`
    // read this matcher used to perform threw a TypeError once `browser` compared equal (undefined
    // === undefined). Surfaces that agree must resolve, not crash.
    const apiAttempt = {
      attemptId: "ATTEMPT-API", status: "PASSED", executionSurface: "api" as const,
      requirementId: apiObligation.requirementId, role: apiObligation.role, behavior: apiObligation.behavior,
      risk: apiObligation.risk, outcome: apiObligation.outcome,
    };

    const evaluation = evaluateCoverage([apiObligation], [apiAttempt]);

    expect(evaluation.satisfied).toEqual([apiObligation.obligationId]);
    expect(evaluation.qualifyingAttemptIds).toEqual(["ATTEMPT-API"]);
  });

  it("decides on the surface alone, even when browser dimensions would otherwise line up exactly", () => {
    // Defense in depth: the schema forbids a non-browser obligation from carrying these at all, so
    // this record could only arise from a bug or tampering. The surface must still be decisive —
    // matching may never fall back to comparing engine + geometry that the surface does not own.
    const smuggled = { ...apiObligation, browser: "chromium", viewport: { width: 1440, height: 900 } };

    const evaluation = evaluateCoverage([smuggled], [matchingAttempt()]);

    expect(evaluation.satisfied).toEqual([]);
    expect(evaluation.missing).toEqual([apiObligation.obligationId]);
  });

  it("keeps crediting the browser obligation in a mixed set while the non-browser one stays unmet", () => {
    // As above: the api obligation must genuinely match on every dimension other than surface, or the
    // browser attempt's own `observedEngine`/`viewport` mismatch against an undefined obligation `browser`
    // would reject it for that reason alone, leaving the mixed-set claim this test's name makes
    // untested — it would pass even with the surface check deleted outright.
    const fullyMatchingApiObligation = { ...apiObligation, browser: obligation.browser, viewport: obligation.viewport };

    const evaluation = evaluateCoverage([obligation, fullyMatchingApiObligation], [matchingAttempt()]);

    expect(evaluation.satisfied).toEqual([obligation.obligationId]);
    expect(evaluation.missing).toEqual([apiObligation.obligationId]);
  });
});
