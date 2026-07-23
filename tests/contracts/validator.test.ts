import { describe, expect, it } from "vitest";

import { validateArtifact } from "../../src/contracts/validator.js";
import type { ArtifactType } from "../../src/contracts/types.js";

const validRun = {
  artifactType: "run-metadata",
  schemaVersion: "1.0.0",
  producerVersion: "1.0.0",
  runId: "20260723T123456Z-a1b2c3",
  status: "CREATED",
  createdAt: "2026-07-23T12:34:56.000Z",
  mode: "full",
  environmentProfileId: "env-staging",
};

const otherArtifactContracts = [
  {
    type: "artifact-manifest",
    requiredField: "runId",
    valid: {
      artifactType: "artifact-manifest",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      runId: "20260723T123456Z-a1b2c3",
      artifacts: [],
    },
  },
  {
    type: "environment-profile",
    requiredField: "name",
    valid: {
      artifactType: "environment-profile",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      environmentProfileId: "env-staging",
      name: "Staging",
      classification: "staging",
      baseUrl: "https://staging.example.test",
      productionReadOnly: false,
    },
  },
  {
    type: "test-case",
    requiredField: "steps",
    valid: {
      artifactType: "test-case",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      testCaseId: "TC-1",
      revisionId: "REV-1",
      instanceId: "TC-1--INSTANCE-1",
      title: "A valid test case",
      steps: [{ id: "step-1", action: "navigate", sideEffect: "none" }],
      coverage: {
        requirementId: "REQ-1", role: "member", behavior: "sign in", browser: "chromium",
        viewport: { width: 1440, height: 900 }, accessibilityMethod: null, risk: "medium", outcome: "account opens",
      },
    },
  },
  {
    type: "test-step-result",
    requiredField: "durationMs",
    valid: {
      artifactType: "test-step-result",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      attemptId: "01K0ABCDEFGHJKMNPQRSTVWXYZ",
      stepId: "step-1",
      status: "PASSED",
      durationMs: 0,
    },
  },
  {
    type: "test-result",
    requiredField: "failureClassification",
    valid: {
      artifactType: "test-result",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      attemptId: "01K0ABCDEFGHJKMNPQRSTVWXYZ",
      runId: "20260723T123456Z-a1b2c3",
      testCaseId: "TC-1",
      testCaseRevisionId: "REV-1",
      testCaseInstanceId: "TC-1--INSTANCE-1",
      status: "PASSED",
      failureClassification: "NONE",
      steps: [{ stepId: "step-1", status: "PASSED", durationMs: 1 }],
      startedAt: "2026-07-23T12:34:56.000Z",
      finishedAt: "2026-07-23T12:35:56.000Z",
    },
  },
  {
    type: "evidence",
    requiredField: "sha256",
    valid: {
      artifactType: "evidence",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      evidenceId: "01K0ABCDEFGHJKMNPQRSTVWXYZ",
      runId: "20260723T123456Z-a1b2c3",
      attemptId: "01K0ABCDEFGHJKMNPQRSTVWXYZ",
      testCaseId: "TC-1",
      testCaseRevisionId: "REV-1",
      testCaseInstanceId: "INSTANCE-1",
      kind: "log",
      capturedAt: "2026-07-23T12:34:56.000Z",
      sha256: "a".repeat(64),
      relativePath: "evidence/log.json",
      mediaType: "application/json",
      binaryArtifactIds: ["binary-1"],
      binaryArtifacts: [{ id: "binary-1", relativePath: "evidence/log.json", sha256: "a".repeat(64), mediaType: "application/json" }],
      provenance: { captureType: "log", dimensions: { width: 1, height: 1 }, dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 1, height: 1 }, url: "about:blank", viewport: { width: 1, height: 1 }, browser: "chromium", build: "test", capturedAt: "2026-07-23T12:34:56.000Z" },
    },
  },
  {
    type: "bug-report",
    requiredField: "actual",
    valid: {
      artifactType: "bug-report",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      bugId: "BUG-LOGIN-A1B2C3-001",
      runId: "20260723T123456Z-a1b2c3",
      attemptId: "01K0ABCDEFGHJKMNPQRSTVWXYZ",
      triageStatus: "NEEDS_TRIAGE",
      expected: "A successful sign in",
      actual: "The sign in request failed",
      environment: { environmentProfileId: "env-staging", name: "Staging", classification: "staging", baseUrl: "https://staging.example.test" },
      reproduction: { attemptIds: ["01K0ABCDEFGHJKMNPQRSTVWXYZ"], attempted: 1, total: 2, rate: "1/2", outcome: "RERUN_OMITTED_UNSAFE", unsafeRerunReason: "Unsafe to retry" },
      evidenceIds: ["01K0ABCDEFGHJKMNPQRSTVWXYZ"],
      affectedAreas: ["TC-1"], openQuestions: ["Assess impact"], provenance: { sourceAttemptIds: ["01K0ABCDEFGHJKMNPQRSTVWXYZ"], evidenceArtifactIds: ["artifact-evidence-1"] }, fingerprint: "a".repeat(64), testPriority: "high", open: true,
    },
  },
  {
    type: "test-data-manifest",
    requiredField: "resources",
    valid: {
      artifactType: "test-data-manifest",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      runId: "20260723T123456Z-a1b2c3",
      resources: [],
    },
  },
  {
    type: "qa-execution-report",
    requiredField: "summary",
    valid: {
      artifactType: "qa-execution-report",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      runId: "20260723T123456Z-a1b2c3",
      generatedAt: "2026-07-23T12:34:56.000Z",
      releaseRecommendation: "READY",
      summary: "All planned checks completed.",
      build: { identifier: "build-1" }, coverageMethods: [], incidents: [], bugs: [], telemetryFindings: [], evidenceGaps: [], cleanupLeaks: [], criticalFindings: [], remainingRisks: [], excludedNotRun: [], releaseGate: { sourceArtifacts: [], recommendation: "READY", ruleInputs: {}, verdicts: [] },
    },
  },
  {
    type: "evidence-gap",
    requiredField: "affectedClaim",
    valid: {
      artifactType: "evidence-gap",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      evidenceGapId: "GAP-1", runId: "20260723T123456Z-a1b2c3", scope: "operational",
      reason: "The upstream system redacted the response.",
      affectedClaim: "The order was persisted successfully.",
    },
  },
] as const satisfies readonly {
  type: Exclude<ArtifactType, "run-metadata">;
  requiredField: string;
  valid: Record<string, unknown>;
}[];

describe("validateArtifact", () => {
  it("accepts a valid run metadata envelope", () => {
    expect(validateArtifact("run-metadata", validRun).valid).toBe(true);
  });

  it("rejects an invalid run status without mutating the supplied artifact", () => {
    const invalidRun = { ...validRun, status: "PASS" };
    const beforeValidation = structuredClone(invalidRun);

    const result = validateArtifact("run-metadata", invalidRun);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instancePath: "/status", keyword: "enum" }),
      ]),
    );
    expect(invalidRun).toEqual(beforeValidation);
  });

  it("requires finalizedProfile exactly for terminal run states", () => {
    const finalizedProfile = { name: "full", version: "1.0.0" };

    expect(validateArtifact("run-metadata", { ...validRun, finalizedProfile }).valid).toBe(false);
    expect(validateArtifact("run-metadata", { ...validRun, status: "FINALIZING", finalizedProfile }).valid).toBe(false);
    expect(validateArtifact("run-metadata", { ...validRun, status: "COMPLETED" }).valid).toBe(false);
    expect(validateArtifact("run-metadata", { ...validRun, status: "COMPLETED", finalizedProfile }).valid).toBe(true);
  });

  it("requires a terminal finalized profile name to equal the run mode", () => {
    expect(validateArtifact("run-metadata", {
      ...validRun,
      status: "COMPLETED",
      finalizedProfile: { name: "plan", version: "1.0.0" },
    }).valid).toBe(false);
  });

  it("rejects ungoverned artifact types in manifests", () => {
    expect(validateArtifact("artifact-manifest", {
      artifactType: "artifact-manifest",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      runId: validRun.runId,
      artifacts: [{
        id: "artifact-1",
        type: "unknown-type",
        relativePath: "inputs/unknown.json",
        sha256: "a".repeat(64),
        provenance: "agent-draft",
        relationships: [],
      }],
    }).valid).toBe(false);
  });

  it("validates typed non-product incidents and deterministic release-gate envelopes", () => {
    expect(validateArtifact("incident", {
      artifactType: "incident", schemaVersion: "1.0.0", producerVersion: "1.0.0", incidentId: "INC-1", runId: validRun.runId, attemptId: "ATTEMPT-1", kind: "TEST_INCIDENT", summary: "A test fixture failed.",
      environment: { environmentProfileId: "env-staging", name: "Staging", classification: "staging", baseUrl: "https://staging.example.test" }, evidenceIds: ["EVIDENCE-1"], affectedAreas: ["TC-1"], openQuestions: [], provenance: { sourceAttemptId: "ATTEMPT-1" },
    }).valid).toBe(true);
    expect(validateArtifact("release-gate", {
      artifactType: "release-gate", schemaVersion: "1.0.0", producerVersion: "1.0.0", runId: validRun.runId, sourceArtifacts: [], recommendation: "READY", ruleInputs: {}, verdicts: [{ rule: "VALID_ARTIFACTS", passed: true, reason: "All registered artifacts are valid." }],
    }).valid).toBe(true);
  });

  describe("the remaining canonical schemas", () => {
    for (const contract of otherArtifactContracts) {
      it(`accepts a minimal valid ${contract.type} artifact`, () => {
        expect(validateArtifact(contract.type, contract.valid).valid).toBe(true);
      });

      it(`rejects a ${contract.type} artifact missing ${contract.requiredField}`, () => {
        const invalid: Record<string, unknown> = { ...contract.valid };
        delete invalid[contract.requiredField];

        expect(validateArtifact(contract.type, invalid).errors).toEqual(
          expect.arrayContaining([expect.objectContaining({ keyword: "required" })]),
        );
      });

      it(`rejects additional properties on ${contract.type} artifacts`, () => {
        expect(validateArtifact(contract.type, { ...contract.valid, unexpected: true }).errors).toEqual(
          expect.arrayContaining([expect.objectContaining({ keyword: "additionalProperties" })]),
        );
      });
    }

    it.each([
      ["environment profile classification", "environment-profile", { ...otherArtifactContracts[1].valid, classification: "preview" }],
      ["test case side-effect class", "test-case", { ...otherArtifactContracts[2].valid, steps: [{ id: "step-1", action: "navigate", sideEffect: "unsafe" }] }],
      ["test step result status", "test-step-result", { ...otherArtifactContracts[3].valid, status: "SUCCESS" }],
      ["test result execution status", "test-result", { ...otherArtifactContracts[4].valid, status: "SUCCESS" }],
      ["test result failure classification", "test-result", { ...otherArtifactContracts[4].valid, failureClassification: "UNKNOWN" }],
      ["evidence kind", "evidence", { ...otherArtifactContracts[5].valid, kind: "video" }],
      ["bug report triage status", "bug-report", { ...otherArtifactContracts[6].valid, triageStatus: "OPEN" }],
      ["bug report severity", "bug-report", { ...otherArtifactContracts[6].valid, severity: "Urgent" }],
      ["QA report release recommendation", "qa-execution-report", { ...otherArtifactContracts[8].valid, releaseRecommendation: "GO" }],
    ] as const)("rejects invalid %s enum values", (_label, type, artifact) => {
      expect(validateArtifact(type, artifact).errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ keyword: "enum" })]),
      );
    });

    it("forbids severity before a bug is triaged", () => {
      expect(validateArtifact("bug-report", { ...otherArtifactContracts[6].valid, severity: "Major" }).valid).toBe(false);
    });
  });
});
