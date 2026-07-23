import { describe, expect, it } from "vitest";

import { evaluateReleaseGate } from "../../src/reporting/release-gate.js";

const passing = { artifactsValid: true, coverage: { requiredMissing: [], optionalGaps: [], requiredHighRisk: [{ obligationId: "COV-PAY", passed: true }] }, bugs: [], sharedBlockers: [] };

describe("evaluateReleaseGate", () => {
  it("records every deterministic rule input and blocks invalid artifacts, shared blockers, critical defects, untriaged bugs, coverage, and high-risk failures", () => {
    for (const input of [
      { ...passing, artifactsValid: false },
      { ...passing, sharedBlockers: ["database unavailable"] },
      { ...passing, bugs: [{ bugId: "BUG-1", triageStatus: "TRIAGED" as const, severity: "Critical" as const, open: true }] },
      { ...passing, bugs: [{ bugId: "BUG-2", triageStatus: "NEEDS_TRIAGE" as const, open: true }] },
      { ...passing, coverage: { ...passing.coverage, requiredMissing: ["COV-REQUIRED"] } },
      { ...passing, coverage: { ...passing.coverage, requiredHighRisk: [{ obligationId: "COV-PAY", passed: false }] } },
    ]) expect(evaluateReleaseGate(input).recommendation).toBe("NOT_READY");
  });

  it("distinguishes acceptable risk from ready", () => {
    expect(evaluateReleaseGate({ ...passing, coverage: { ...passing.coverage, optionalGaps: ["COV-OPTIONAL"] } }).recommendation).toBe("READY_WITH_RISKS");
    expect(evaluateReleaseGate({ ...passing, bugs: [{ bugId: "BUG-3", triageStatus: "TRIAGED", severity: "Major", open: true }] }).recommendation).toBe("READY_WITH_RISKS");
    expect(evaluateReleaseGate(passing)).toMatchObject({ recommendation: "READY", ruleInputs: passing });
  });
});
