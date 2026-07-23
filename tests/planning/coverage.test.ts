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
  authoritativeRequirement: true,
};

function matchingAttempt(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: "ATTEMPT-PASS",
    status: "PASSED",
    authoritativeRequirement: true,
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
