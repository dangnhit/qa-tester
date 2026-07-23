import { describe, expect, it } from "vitest";

import { deriveReleaseGateFromWorkspaceArtifacts, evaluateReleaseGate } from "../../src/reporting/release-gate.js";

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

  it("never recommends READY while an Evidence Gap leaves a claim unsubstantiated", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([{
      record: { id: "GAP-1", sha256: "a".repeat(64), type: "evidence-gap" },
      value: {
        artifactType: "evidence-gap",
        schemaVersion: "1.0.0",
        producerVersion: "0.1.0",
        evidenceGapId: "GAP-1",
        runId: "RUN-1",
        scope: "operational",
        reason: "Required video could not be captured.",
        affectedClaim: "video capture",
      },
    }]);

    expect(result.recommendation).toBe("NOT_READY");
    expect(result.ruleInputs.sharedBlockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/evidence gap.*video capture/i),
    ]));
  });
});
