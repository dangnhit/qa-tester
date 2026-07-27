import { describe, expect, it } from "vitest";

import { formatValidationErrors, validateArtifact } from "../../src/contracts/validator.js";
import type { ArtifactType, NormalizedValidationError } from "../../src/contracts/types.js";

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
      schemaVersion: "2.0.0",
      producerVersion: "1.0.0",
      attemptId: "01K0ABCDEFGHJKMNPQRSTVWXYZ",
      runId: "20260723T123456Z-a1b2c3",
      testCaseId: "TC-1",
      testCaseRevisionId: "REV-1",
      testCaseInstanceId: "TC-1--INSTANCE-1",
      status: "PASSED",
      failureClassification: "NONE",
      observedEngine: "chromium",
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
      schemaVersion: "2.0.0",
      producerVersion: "1.0.0",
      evidenceId: "01K0ABCDEFGHJKMNPQRSTVWXYZ",
      runId: "20260723T123456Z-a1b2c3",
      subject: { kind: "attempt", attemptId: "01K0ABCDEFGHJKMNPQRSTVWXYZ", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" },
      kind: "log",
      capturedAt: "2026-07-23T12:34:56.000Z",
      sha256: "a".repeat(64),
      relativePath: "evidence/log.json",
      mediaType: "application/json",
      binaryArtifactIds: ["binary-1"],
      binaryArtifacts: [{ id: "binary-1", relativePath: "evidence/log.json", sha256: "a".repeat(64), mediaType: "application/json" }],
      provenance: { captureType: "log", url: "about:blank", browser: "chromium", build: "test", capturedAt: "2026-07-23T12:34:56.000Z" },
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
  {
    type: "test-result-batch",
    requiredField: "entries",
    valid: {
      artifactType: "test-result-batch",
      schemaVersion: "2.0.0",
      producerVersion: "1.0.0",
      executionId: "EXEC-1",
      runId: "20260723T123456Z-a1b2c3",
      commitSha: "b".repeat(40),
      specTreeSha256: "c".repeat(64),
      startedAt: "2026-07-23T12:34:56.000Z",
      finishedAt: "2026-07-23T12:35:56.000Z",
      entries: [{
        entryId: "ENTRY-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "TC-1--INSTANCE-1",
        status: "PASSED", failureClassification: "NONE", observedEngine: "chromium",
        steps: [{ stepId: "step-1", status: "PASSED", durationMs: 1 }],
      }],
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

/** Evidence 2.0.0 replaced four flat identity fields with a `subject` union and made `provenance`
 *  a discriminated union on `captureType`. These pin the two shapes the bump exists to make honest:
 *  a non-screenshot capture may not carry geometry it never measured, and evidence may be about an
 *  externally observed execution rather than a runtime-driven attempt. */
describe("evidence schema 2.0.0", () => {
  const attemptSubject = { kind: "attempt", attemptId: "01K0ABCDEFGHJKMNPQRSTVWXYZ", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" };
  const logEvidence = {
    artifactType: "evidence", schemaVersion: "2.0.0", producerVersion: "1.0.0",
    evidenceId: "01K0ABCDEFGHJKMNPQRSTVWXYZ", runId: "20260723T123456Z-a1b2c3",
    subject: attemptSubject, kind: "log", capturedAt: "2026-07-23T12:34:56.000Z",
    sha256: "a".repeat(64), relativePath: "evidence/log.json", mediaType: "application/json",
    binaryArtifactIds: ["binary-1"],
    binaryArtifacts: [{ id: "binary-1", relativePath: "evidence/log.json", sha256: "a".repeat(64), mediaType: "application/json" }],
    provenance: { captureType: "log", url: "about:blank", browser: "chromium", build: "test", capturedAt: "2026-07-23T12:34:56.000Z" },
  };
  const screenshotGeometry = { dimensions: { width: 120, height: 80 }, dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 120, height: 80 }, viewport: { width: 120, height: 80 } };
  const screenshotEvidence = {
    ...logEvidence, kind: "screenshot", relativePath: "evidence/shot.png", mediaType: "image/png",
    binaryArtifacts: [{ id: "binary-1", relativePath: "evidence/shot.png", sha256: "a".repeat(64), mediaType: "image/png" }],
    provenance: { captureType: "screenshot", ...screenshotGeometry, url: "about:blank", browser: "chromium", build: "test", capturedAt: "2026-07-23T12:34:56.000Z" },
  };

  it("accepts a non-screenshot capture that declares no geometry at all", () => {
    expect(validateArtifact("evidence", logEvidence).valid).toBe(true);
  });

  it("accepts a non-screenshot capture that keeps a genuinely known viewport", () => {
    expect(validateArtifact("evidence", { ...logEvidence, provenance: { ...logEvidence.provenance, viewport: { width: 1280, height: 720 } } }).valid).toBe(true);
  });

  it.each(["dimensions", "dpr", "scroll", "clip", "cssBoxes", "pixelBoxes", "locator", "annotationLabels"] as const)(
    "forbids (not merely permits) %s on a non-screenshot capture",
    (field) => {
      const fabricated: Record<string, unknown> = { dimensions: { width: 1, height: 1 }, dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 1, height: 1 }, cssBoxes: [], pixelBoxes: [], locator: "#root", annotationLabels: ["label"] };
      expect(validateArtifact("evidence", { ...logEvidence, provenance: { ...logEvidence.provenance, [field]: fabricated[field] } }).valid).toBe(false);
    },
  );

  it("accepts a screenshot carrying its full measured geometry", () => {
    expect(validateArtifact("evidence", screenshotEvidence).valid).toBe(true);
  });

  it.each(["dimensions", "dpr", "scroll", "clip", "viewport"] as const)("rejects a screenshot missing %s", (field) => {
    const provenance: Record<string, unknown> = { ...screenshotEvidence.provenance };
    delete provenance[field];
    expect(validateArtifact("evidence", { ...screenshotEvidence, provenance }).valid).toBe(false);
  });

  it("accepts an observed-execution subject naming only its executionId", () => {
    expect(validateArtifact("evidence", { ...logEvidence, subject: { kind: "observed-execution", executionId: "EXEC-1" } }).valid).toBe(true);
  });

  it("rejects an attempt subject smuggling an executionId", () => {
    expect(validateArtifact("evidence", { ...logEvidence, subject: { ...attemptSubject, executionId: "EXEC-1" } }).valid).toBe(false);
  });

  it("rejects an observed-execution subject smuggling an attemptId", () => {
    expect(validateArtifact("evidence", { ...logEvidence, subject: { kind: "observed-execution", executionId: "EXEC-1", attemptId: "ATTEMPT-1" } }).valid).toBe(false);
  });

  it("rejects the four flat identity fields the subject union replaced", () => {
    expect(validateArtifact("evidence", { ...logEvidence, attemptId: "ATTEMPT-1" }).valid).toBe(false);
  });

  it("rejects evidence still declaring schemaVersion 1.0.0", () => {
    expect(validateArtifact("evidence", { ...logEvidence, schemaVersion: "1.0.0" }).valid).toBe(false);
  });
});

/** `test-result` 2.0.0 records `observedEngine`: the engine the QA Runtime actually drove, so a Browser
 *  Matrix member is credited from what RAN and never from the engine a test case declared
 *  (CONTEXT.md:442). Two shape decisions are pinned here.
 *
 *  REQUIRED, not optional: an attempt whose engine could not be determined must be unregistrable, so
 *  the field can never be absent-and-therefore-unchecked on a checksummed audit record.
 *
 *  A free non-empty string, NOT an enum of the three Playwright engines: Playwright types
 *  `BrowserType.name()` as `string` ("For example: 'chromium', 'webkit' or 'firefox'"), the
 *  `coverage-obligation.browser` this value is compared against is itself `{type: string, minLength: 1}`,
 *  and lane 2 (Phase 7) will report engines from an external runner's JSON that this repo does not
 *  enumerate. An enum could not make a wrong-but-plausible engine detectable — only rejectable an
 *  honest one, which is the single failure an audit record cannot afford. An unrecognized engine
 *  simply matches no obligation, which is already the fail-closed outcome. */
describe("test-result schema 2.0.0 (observed engine)", () => {
  const result = otherArtifactContracts[4].valid;

  it("rejects a test result that does not record the engine it observed", () => {
    const missing: Record<string, unknown> = { ...result };
    delete missing.observedEngine;

    expect(validateArtifact("test-result", missing).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "required" })]),
    );
  });

  it("rejects a test result still declaring schemaVersion 1.0.0", () => {
    expect(validateArtifact("test-result", { ...result, schemaVersion: "1.0.0" }).valid).toBe(false);
  });

  it("rejects an empty observed engine, which would name no engine at all", () => {
    expect(validateArtifact("test-result", { ...result, observedEngine: "" }).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "minLength" })]),
    );
  });

  it("accepts an engine name this repo does not enumerate, so an honest lane-2 observation is never rejected", () => {
    for (const engine of ["chromium", "firefox", "webkit", "msedge", "some-external-runner-engine"]) {
      expect(validateArtifact("test-result", { ...result, observedEngine: engine }).valid).toBe(true);
    }
  });
});

/** `test-result-batch` is the lane-2 artifact shape: one artifact per Runtime-Observed Execution,
 *  carrying many entries. These pin the fields that make such a batch auditable — the git anchor
 *  (`commitSha` + `specTreeSha256`, ADR-0010) that is the only reason an observed execution may credit
 *  coverage, and the per-entry identity + status shape the coverage readers flatten. */
describe("test-result-batch schema (Runtime-Observed Execution)", () => {
  const entry = {
    entryId: "ENTRY-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "TC-1--INSTANCE-1",
    status: "PASSED", failureClassification: "NONE", observedEngine: "chromium",
    steps: [{ stepId: "step-1", status: "PASSED", durationMs: 1 }],
  };
  const batch = {
    artifactType: "test-result-batch", schemaVersion: "2.0.0", producerVersion: "1.0.0",
    executionId: "EXEC-1", runId: "20260723T123456Z-a1b2c3",
    commitSha: "b".repeat(40), specTreeSha256: "c".repeat(64),
    startedAt: "2026-07-23T12:34:56.000Z", finishedAt: "2026-07-23T12:35:56.000Z",
    entries: [entry],
  };

  it("accepts a minimal valid batch", () => {
    expect(validateArtifact("test-result-batch", batch).valid).toBe(true);
  });

  it.each(["commitSha", "specTreeSha256", "entries", "executionId", "runId"] as const)("rejects a batch missing %s", (field) => {
    const invalid: Record<string, unknown> = { ...batch };
    delete invalid[field];

    expect(validateArtifact("test-result-batch", invalid).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "required" })]),
    );
  });

  it("rejects a batch carrying no entries", () => {
    expect(validateArtifact("test-result-batch", { ...batch, entries: [] }).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "minItems" })]),
    );
  });

  it.each([
    ["commit SHA", { commitSha: "not-a-sha" }],
    ["spec tree checksum", { specTreeSha256: "c".repeat(63) }],
  ] as const)("rejects a non-hex git anchor: %s", (_label, override) => {
    expect(validateArtifact("test-result-batch", { ...batch, ...override }).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "pattern" })]),
    );
  });

  it("rejects a batch declaring a provenance field (crediting is the manifest record's decision)", () => {
    expect(validateArtifact("test-result-batch", { ...batch, provenance: "runtime-observed" }).valid).toBe(false);
  });

  it("rejects a batch declaring any schemaVersion other than 2.0.0", () => {
    expect(validateArtifact("test-result-batch", { ...batch, schemaVersion: "1.0.0" }).valid).toBe(false);
    expect(validateArtifact("test-result-batch", { ...batch, schemaVersion: "3.0.0" }).valid).toBe(false);
  });

  it.each(["entryId", "testCaseId", "testCaseRevisionId", "testCaseInstanceId", "status", "failureClassification", "observedEngine", "steps"] as const)("rejects an entry missing %s", (field) => {
    const invalidEntry: Record<string, unknown> = { ...entry };
    delete invalidEntry[field];

    expect(validateArtifact("test-result-batch", { ...batch, entries: [invalidEntry] }).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "required" })]),
    );
  });

  it.each([
    ["entry execution status", { status: "SUCCESS" }],
    ["entry failure classification", { failureClassification: "UNKNOWN" }],
    ["entry step status", { steps: [{ stepId: "step-1", status: "SUCCESS", durationMs: 1 }] }],
  ] as const)("rejects an invalid %s enum value", (_label, override) => {
    expect(validateArtifact("test-result-batch", { ...batch, entries: [{ ...entry, ...override }] }).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "enum" })]),
    );
  });

  it("rejects unknown properties on an entry", () => {
    expect(validateArtifact("test-result-batch", { ...batch, entries: [{ ...entry, attemptId: "ATTEMPT-1" }] }).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "additionalProperties" })]),
    );
  });

  it("accepts an entry declaring evidence artifact IDs and rejects an empty declaration", () => {
    const failing = { ...entry, status: "FAILED", failureClassification: "PRODUCT_DEFECT" };
    expect(validateArtifact("test-result-batch", { ...batch, entries: [{ ...failing, evidenceArtifactIds: ["EVIDENCE-1"] }] }).valid).toBe(true);
    expect(validateArtifact("test-result-batch", { ...batch, entries: [{ ...failing, evidenceArtifactIds: [] }] }).valid).toBe(false);
  });
});

/** `coverage-obligation` 2.0.0 makes the Execution Surface an explicit, declared field so that a
 *  surface the runtime cannot execute is still authorable and therefore still *countable*
 *  (CONTEXT.md:443-445). `browser` and `viewport` describe the browser surface only; on every other
 *  surface they are FORBIDDEN, not merely optional, for the same reason Phase 5 forbade geometry on
 *  non-screenshot evidence — an optional field lets a fabricated value survive into a checksummed
 *  audit record. */
describe("coverage-obligation schema 2.0.0 (executionSurface)", () => {
  /** Everything an obligation carries no matter which surface it declares. */
  const common = {
    artifactType: "coverage-obligation", schemaVersion: "2.0.0", producerVersion: "1.0.0",
    obligationId: "COV-1", requirementId: "REQ-1", requirementAnalysisArtifactId: "RA-1",
    role: "member", behavior: "sign in",
    accessibilityMethod: null, risk: "high", required: true, outcome: "account page opens",
  };
  const browserGeometry = { browser: "chromium", viewport: { width: 1440, height: 900 } };
  const browserObligation = { ...common, executionSurface: "browser", ...browserGeometry };
  /** The same obligation on a surface no executor covers: no engine, no geometry, still authorable. */
  const apiObligation = { ...common, obligationId: "COV-API", executionSurface: "api" };

  it("accepts a browser obligation carrying its engine and viewport", () => {
    expect(validateArtifact("coverage-obligation", browserObligation).valid).toBe(true);
  });

  it.each(["browser", "viewport"] as const)("rejects a browser obligation missing %s", (field) => {
    const partial: Record<string, unknown> = { ...browserObligation };
    delete partial[field];
    expect(validateArtifact("coverage-obligation", partial).valid).toBe(false);
  });

  it.each(["api", "unit", "integration", "performance", "security", "manual"] as const)(
    "accepts a %s obligation that declares neither browser nor viewport",
    (surface) => {
      expect(validateArtifact("coverage-obligation", { ...apiObligation, executionSurface: surface }).valid).toBe(true);
    },
  );

  it.each([["browser", "chromium"], ["viewport", { width: 1440, height: 900 }]] as const)(
    "forbids (not merely permits) %s on a non-browser obligation",
    (field, value) => {
      expect(validateArtifact("coverage-obligation", { ...apiObligation, [field]: value }).valid).toBe(false);
    },
  );

  it("rejects an obligation that declares no execution surface at all", () => {
    expect(validateArtifact("coverage-obligation", { ...common, ...browserGeometry }).valid).toBe(false);
  });

  it("rejects an unknown execution surface value", () => {
    expect(validateArtifact("coverage-obligation", { ...browserObligation, executionSurface: "smoke" }).valid).toBe(false);
  });

  it("rejects an obligation still declaring schemaVersion 1.0.0 (hard break, no migration layer)", () => {
    expect(validateArtifact("coverage-obligation", { ...browserObligation, schemaVersion: "1.0.0" }).valid).toBe(false);
  });
});

describe("formatValidationErrors", () => {
  it("renders each error's instancePath and message, in Ajv's original order", () => {
    const errors: NormalizedValidationError[] = [
      { instancePath: "/status", schemaPath: "#/properties/status/enum", keyword: "enum", message: "must be equal to one of the allowed values" },
      { instancePath: "/title", schemaPath: "#/required", keyword: "required", message: "must have required property 'title'" },
    ];

    const formatted = formatValidationErrors(errors);

    expect(formatted).toContain("/status");
    expect(formatted).toContain("must be equal to one of the allowed values");
    expect(formatted).toContain("/title");
    expect(formatted).toContain("must have required property 'title'");
    expect(formatted.indexOf("/status")).toBeLessThan(formatted.indexOf("/title"));
  });

  it("falls back to a short diagnostic-free message for an empty error list", () => {
    expect(formatValidationErrors([])).toBe("no diagnostics available");
  });
});
