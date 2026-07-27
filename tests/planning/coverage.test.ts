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
    browser: obligation.browser,
    viewport: obligation.viewport,
    accessibilityMethod: obligation.accessibilityMethod,
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

  it.each([
    ["requirement", { requirementId: "REQ-OTHER" }],
    ["role", { role: "admin" }],
    ["behavior", { behavior: "delete profile" }],
    ["browser", { browser: "webkit" }],
    ["viewport", { viewport: { width: 390, height: 844 } }],
    ["accessibility method", { accessibilityMethod: "manual-keyboard" }],
    ["risk", { risk: "low" }],
    ["outcome", { outcome: "redirected" }],
  ])("does not satisfy an obligation with a mismatched %s", (_dimension, mismatch) => {
    const evaluation = evaluateCoverage([obligation], [matchingAttempt(mismatch)]);

    expect(evaluation.satisfied).toEqual([]);
    expect(evaluation.missing).toEqual([obligation.obligationId]);
  });
});

/** An obligation declares exactly one Execution Surface (CONTEXT.md:443). The runtime executes only
 *  the browser surface, so every other surface is authorable but unexecuted — and must therefore stay
 *  EXPLICITLY UNMET rather than quietly vanish (CONTEXT.md:445). */
describe("evaluateCoverage — execution surfaces", () => {
  /** A required obligation on a surface no executor covers: no engine, no geometry, by design. */
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
    // pass merely because `attempt.browser !== obligation.browser` ("chromium" vs `undefined`), without
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
      accessibilityMethod: apiObligation.accessibilityMethod, risk: apiObligation.risk, outcome: apiObligation.outcome,
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
    // browser attempt's own `browser`/`viewport` mismatch against an undefined obligation `browser`
    // would reject it for that reason alone, leaving the mixed-set claim this test's name makes
    // untested — it would pass even with the surface check deleted outright.
    const fullyMatchingApiObligation = { ...apiObligation, browser: obligation.browser, viewport: obligation.viewport };

    const evaluation = evaluateCoverage([obligation, fullyMatchingApiObligation], [matchingAttempt()]);

    expect(evaluation.satisfied).toEqual([obligation.obligationId]);
    expect(evaluation.missing).toEqual([apiObligation.obligationId]);
  });
});
