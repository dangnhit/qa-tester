import { describe, expect, it } from "vitest";

import { evaluateCoverage } from "../../src/planning/coverage.js";

const obligation = {
  obligationId: "COV-SAVE-CHROMIUM",
  requirementId: "REQ-SAVE",
  role: "member",
  behavior: "save profile",
  browser: "chromium",
  viewport: { width: 1440, height: 900 },
  risk: "high",
  required: true,
  outcome: "confirmation shown",
};

describe("evaluateCoverage", () => {
  it("satisfies an obligation only with a passed authoritative attempt addressing it", () => {
    const evaluation = evaluateCoverage([obligation], [
      { attemptId: "ATTEMPT-INFERRED", status: "PASSED", authority: "INFERRED", obligationIds: [obligation.obligationId] },
      { attemptId: "ATTEMPT-FAILED", status: "FAILED", authority: "AUTHORITATIVE", obligationIds: [obligation.obligationId] },
      { attemptId: "ATTEMPT-PASS", status: "PASSED", authority: "AUTHORITATIVE", obligationIds: [obligation.obligationId] },
    ]);

    expect(evaluation.satisfied).toEqual([obligation.obligationId]);
    expect(evaluation.missing).toEqual([]);
    expect(evaluation.qualifyingAttemptIds).toEqual(["ATTEMPT-PASS"]);
  });

  it("reports a required obligation as missing when only non-authoritative passing attempts exist", () => {
    const evaluation = evaluateCoverage([obligation], [
      { attemptId: "ATTEMPT-ASSUMED", status: "PASSED", authority: "ASSUMED", obligationIds: [obligation.obligationId] },
    ]);

    expect(evaluation.satisfied).toEqual([]);
    expect(evaluation.missing).toEqual([obligation.obligationId]);
    expect(evaluation.complete).toBe(false);
  });
});
