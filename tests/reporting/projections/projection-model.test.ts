import { describe, expect, it } from "vitest";

import { buildProjectionModel, type ProjectionArtifact } from "../../../src/reporting/projections/projection-model.js";
import { evaluateReleaseGate } from "../../../src/reporting/release-gate.js";
import { identifierOnlyGateRules } from "../../../src/reporting/projections/projection-model.js";

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
  record: { id: "tr-1", sha256: "b".repeat(64), type: "test-result", provenance: "runtime-execution" },
  value: {
    artifactType: "test-result", attemptId: "ATT-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1",
    status: "FAILED", failureClassification: "PRODUCT_DEFECT", observedEngine: "chromium",
    steps: [{ stepId: "S1", status: "PASSED", durationMs: 1200 }, { stepId: "S2", status: "FAILED", durationMs: 300 }],
  },
};

const batch: ProjectionArtifact = {
  record: { id: "batch-1", sha256: "c".repeat(64), type: "test-result-batch", provenance: "runtime-observed" },
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
      provenance: "runtime-execution",
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

  it("carries each row's own record provenance, so a runtime-observed row is distinguishable from a runtime-executed one", () => {
    const model = buildProjectionModel({ ...base, artifacts: [gateArtifact, drivenAttempt, batch] });
    expect(model.attempts.map((row) => [row.id, row.provenance])).toEqual([
      ["ATT-1", "runtime-execution"],
      ["E-1", "runtime-observed"],
      ["E-2", "runtime-observed"],
    ]);
  });
});

const withFindings = (protectedEnvironment: boolean): ProjectionArtifact => ({
  record: { id: "gate-2", sha256: "a".repeat(64), type: "release-gate" },
  value: {
    artifactType: "release-gate", recommendation: "NOT_READY", protectedEnvironment,
    sourceArtifacts: [],
    ruleInputs: {
      artifactsValid: true,
      coverage: { requiredMissing: ["COV-1"], optionalGaps: ["COV-2"], requiredHighRisk: [] },
      bugs: [{ bugId: "BUG-1", triageStatus: "TRIAGED", severity: "Critical", open: true },
             { bugId: "BUG-2", triageStatus: "TRIAGED", severity: "Minor", open: true },
             { bugId: "BUG-3", triageStatus: "TRIAGED", severity: "Major", open: false }],
      sharedBlockers: ["Evidence gap GAP-1 affects the checkout total shown to a signed-in buyer"],
    },
    verdicts: [
      { rule: "NO_SHARED_BLOCKERS", passed: false, reason: "Shared blockers: Evidence gap GAP-1 affects the checkout total shown to a signed-in buyer." },
      { rule: "REQUIRED_COVERAGE_COMPLETE", passed: false, reason: "Required coverage missing: COV-1." },
    ],
  },
});

const gapArtifact: ProjectionArtifact = {
  record: { id: "gap-1", sha256: "f".repeat(64), type: "evidence-gap" },
  value: { artifactType: "evidence-gap", evidenceGapId: "GAP-1", reason: "Trace retention refused by the environment profile", affectedClaim: "the checkout total shown to a signed-in buyer" },
};

describe("projection findings", () => {
  it("emits one finding per open bug, unmet requirement, optional gap and evidence gap, and none for a closed bug", () => {
    const model = buildProjectionModel({ ...base, artifacts: [withFindings(false), gapArtifact] });
    expect(model.findings.map((finding) => [finding.ruleId, finding.level, finding.id])).toEqual([
      ["open-bug", "error", "BUG-1"],
      ["open-bug", "warning", "BUG-2"],
      ["required-coverage-unmet", "error", "COV-1"],
      ["optional-coverage-gap", "warning", "COV-2"],
      ["evidence-gap", "warning", "GAP-1"],
    ]);
  });

  it("keeps authored text out of a reduced projection, in findings AND in the one verdict reason that can carry it", () => {
    const model = buildProjectionModel({ ...base, artifacts: [withFindings(true), gapArtifact] });
    expect(model.reduced).toBe(true);
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain("checkout total shown to a signed-in buyer");
    expect(serialized).not.toContain("Trace retention refused");
    expect(model.findings.find((finding) => finding.id === "GAP-1")?.message).toBe("evidence gap GAP-1");
    expect(model.gate.verdicts.find((verdict) => verdict.rule === "NO_SHARED_BLOCKERS")?.reason).toBe("Shared blockers: 1.");
    // Identifier-only reasons survive reduction: they name what is wrong without quoting anyone.
    expect(model.gate.verdicts.find((verdict) => verdict.rule === "REQUIRED_COVERAGE_COMPLETE")?.reason).toBe("Required coverage missing: COV-1.");
  });

  it("pins the set of gate rules whose reason is identifier-only, so a new rule cannot silently join it", () => {
    const everyRule = evaluateReleaseGate({
      artifactsValid: true, coverage: { requiredMissing: [], optionalGaps: [], requiredHighRisk: [] }, bugs: [], sharedBlockers: [],
    }).verdicts.map((verdict) => verdict.rule);
    expect([...everyRule].sort()).toEqual([...identifierOnlyGateRules, "NO_SHARED_BLOCKERS"].sort());
  });
});
