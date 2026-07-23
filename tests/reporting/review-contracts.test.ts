import { describe, expect, it } from "vitest";

import { validateArtifact } from "../../src/contracts/validator.js";
import { deriveReleaseGateFromArtifacts } from "../../src/reporting/release-gate.js";

describe("Task 7 review contracts", () => {
  it("rejects an incident that lacks registered evidence or an evidence gap", () => {
    expect(validateArtifact("incident", {
      artifactType: "incident", schemaVersion: "1.0.0", producerVersion: "0.1.0", incidentId: "INC-1", runId: "run-1", attemptId: "attempt-1", kind: "TEST_INCIDENT", summary: "fixture failed",
      environment: { environmentProfileId: "env-1", name: "Test", classification: "test", baseUrl: "https://example.test" }, evidenceIds: [], evidenceGapIds: [], affectedAreas: ["TC-1"], openQuestions: [], provenance: { sourceAttemptId: "attempt-1" },
    }).valid).toBe(false);
  });

  it("derives the gate snapshot and verdict from canonical registered inputs", () => {
    const gate = deriveReleaseGateFromArtifacts({
      artifactRecords: [{ id: "result-1", sha256: "a".repeat(64), type: "test-result" }],
      coverage: { requiredMissing: [], optionalGaps: [], requiredHighRisk: [] }, bugs: [], incidents: [], evidenceGaps: [], cleanupLeaks: [], sharedBlockers: [], artifactsValid: true,
    });
    expect(gate.recommendation).toBe("READY");
    expect(gate.sourceArtifacts).toEqual([{ id: "result-1", sha256: "a".repeat(64), type: "test-result" }]);
  });
});
