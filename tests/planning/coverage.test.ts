import { describe, expect, it } from "vitest";

import { evaluateCoverage } from "../../src/planning/coverage.js";

const obligation = {
  obligationId: "COV-SAVE-CHROMIUM",
  requirementId: "REQ-SAVE",
  role: "member",
  behavior: "save profile",
  browser: "chromium",
  viewport: { width: 1440, height: 900 },
  accessibilityMethod: undefined,
  risk: "high",
  required: true,
  outcome: "confirmation shown",
};

function matchingAttempt(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: "ATTEMPT-PASS",
    status: "PASSED",
    authority: "AUTHORITATIVE",
    authorityProvenance: "registered-requirement-analysis",
    obligationIds: [obligation.obligationId],
    requirementId: obligation.requirementId,
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
  it("satisfies an obligation only with a passed authoritative attempt addressing it", () => {
    const evaluation = evaluateCoverage([obligation], [
      matchingAttempt({ attemptId: "ATTEMPT-INFERRED", authority: "INFERRED" }),
      matchingAttempt({ attemptId: "ATTEMPT-FAILED", status: "FAILED" }),
      matchingAttempt(),
    ]);

    expect(evaluation.satisfied).toEqual([obligation.obligationId]);
    expect(evaluation.missing).toEqual([]);
    expect(evaluation.qualifyingAttemptIds).toEqual(["ATTEMPT-PASS"]);
  });

  it("reports a required obligation as missing when only non-authoritative passing attempts exist", () => {
    const evaluation = evaluateCoverage([obligation], [
      matchingAttempt({ attemptId: "ATTEMPT-ASSUMED", authority: "ASSUMED" }),
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
    ["authority provenance", { authorityProvenance: "agent-claim" }],
  ])("does not satisfy an obligation with a mismatched %s", (_dimension, mismatch) => {
    const evaluation = evaluateCoverage([obligation], [matchingAttempt(mismatch)]);

    expect(evaluation.satisfied).toEqual([]);
    expect(evaluation.missing).toEqual([obligation.obligationId]);
  });
});
