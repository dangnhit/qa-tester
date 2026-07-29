import { describe, expect, it } from "vitest";

import { buildProjectionModel, type ProjectionArtifact } from "../../../src/reporting/projections/projection-model.js";

const gateArtifact: ProjectionArtifact = {
  record: { id: "gate-1", sha256: "a".repeat(64), type: "release-gate" },
  value: {
    artifactType: "release-gate", recommendation: "NOT_READY", protectedEnvironment: false,
    sourceArtifacts: [{ id: "tr-1", sha256: "b".repeat(64), type: "test-result" }],
    ruleInputs: { artifactsValid: true, coverage: { requiredMissing: ["COV-1"], optionalGaps: [], requiredHighRisk: [] }, bugs: [], sharedBlockers: [] },
    verdicts: [{ rule: "REQUIRED_COVERAGE_COMPLETE", passed: false, reason: "Required coverage missing: COV-1." }],
  },
};

const drivenAttempt: ProjectionArtifact = {
  record: { id: "tr-1", sha256: "b".repeat(64), type: "test-result" },
  value: {
    artifactType: "test-result", attemptId: "ATT-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1",
    status: "FAILED", failureClassification: "PRODUCT_DEFECT", observedEngine: "chromium",
    steps: [{ stepId: "S1", status: "PASSED", durationMs: 1200 }, { stepId: "S2", status: "FAILED", durationMs: 300 }],
  },
};

const batch: ProjectionArtifact = {
  record: { id: "batch-1", sha256: "c".repeat(64), type: "test-result-batch" },
  value: {
    artifactType: "test-result-batch", executionId: "EX-1", commitSha: "d".repeat(40), specTreeSha256: "e".repeat(64),
    entries: [
      { entryId: "E-1", testCaseId: "TC-2", testCaseRevisionId: "REV-2", testCaseInstanceId: "INST-2", status: "PASSED", failureClassification: "NONE", executionSurface: "api", steps: [{ stepId: "S1", status: "PASSED", durationMs: 500 }] },
      { entryId: "E-2", testCaseId: "TC-3", testCaseRevisionId: "REV-3", testCaseInstanceId: "INST-3", status: "NOT_RUN", failureClassification: "NONE", executionSurface: "unit", steps: [{ stepId: "S1", status: "NOT_RUN", durationMs: 0 }] },
    ],
  },
};

const base = { runId: "RUN-1", producerVersion: "0.3.0", generatedAt: "2026-07-29T00:00:00.000Z" };

describe("buildProjectionModel", () => {
  it("refuses a run with no release gate, because an unfinalized run has nothing to project", () => {
    expect(() => buildProjectionModel({ ...base, artifacts: [drivenAttempt] }))
      .toThrowError(/release gate/i);
  });

  it("carries the persisted gate verbatim rather than re-deriving it", () => {
    const model = buildProjectionModel({ ...base, artifacts: [gateArtifact] });
    expect(model.gate).toMatchObject({ artifactId: "gate-1", sha256: "a".repeat(64), recommendation: "NOT_READY" });
    expect(model.gate.verdicts).toEqual([{ rule: "REQUIRED_COVERAGE_COMPLETE", passed: false, reason: "Required coverage missing: COV-1." }]);
    expect(model.sourceArtifacts).toEqual([{ id: "tr-1", sha256: "b".repeat(64), type: "test-result" }]);
  });

  it("reads a lane-1 attempt as the browser surface and sums its measured step durations", () => {
    const model = buildProjectionModel({ ...base, artifacts: [gateArtifact, drivenAttempt] });
    expect(model.attempts).toEqual([{
      lane: "driven-attempt", id: "ATT-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1",
      status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "browser", durationMs: 1500,
    }]);
  });

  it("reads each lane-2 entry as its own row on the surface the entry itself declares", () => {
    const model = buildProjectionModel({ ...base, artifacts: [gateArtifact, batch] });
    expect(model.attempts.map((row) => [row.id, row.executionSurface, row.status, row.durationMs]))
      .toEqual([["E-1", "api", "PASSED", 500], ["E-2", "unit", "NOT_RUN", 0]]);
  });

  it("carries the git anchor when an observed execution exists, and omits it when none does", () => {
    expect(buildProjectionModel({ ...base, artifacts: [gateArtifact, batch] }).anchor)
      .toEqual({ commitSha: "d".repeat(40), specTreeSha256: "e".repeat(64) });
    expect(buildProjectionModel({ ...base, artifacts: [gateArtifact, drivenAttempt] }).anchor).toBeUndefined();
  });
});
