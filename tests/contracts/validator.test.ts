import { describe, expect, it } from "vitest";

import { schemas } from "../../src/contracts/catalog.js";
import { formatValidationErrors, validateArtifact } from "../../src/contracts/validator.js";
import type { ArtifactType, NormalizedValidationError } from "../../src/contracts/types.js";
import { accessibilityMethods, executionSurfaces, manualAccessibilityMethods } from "../../src/planning/coverage.js";

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
      schemaVersion: "3.0.0",
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
      schemaVersion: "3.0.0",
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
      schemaVersion: "3.0.0",
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
      schemaVersion: "2.0.0",
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
      schemaVersion: "4.0.0",
      producerVersion: "1.0.0",
      executionId: "EXEC-1",
      runId: "20260723T123456Z-a1b2c3",
      commitSha: "b".repeat(40),
      specTreeSha256: "c".repeat(64),
      startedAt: "2026-07-23T12:34:56.000Z",
      finishedAt: "2026-07-23T12:35:56.000Z",
      entries: [{
        entryId: "ENTRY-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "TC-1--INSTANCE-1",
        status: "PASSED", failureClassification: "NONE", executionSurface: "browser",
        observedEngine: "chromium", viewport: { width: 1440, height: 900 },
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
 *  a discriminated union on `captureType`; 3.0.0 adds the `runner-report` branch (see the block below).
 *  These pin the two shapes the 2.0.0 bump exists to make honest: a non-screenshot capture may not carry
 *  geometry it never measured, and evidence may be about an externally observed execution rather than a
 *  runtime-driven attempt. */
describe("evidence schema 3.0.0", () => {
  const attemptSubject = { kind: "attempt", attemptId: "01K0ABCDEFGHJKMNPQRSTVWXYZ", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" };
  const logEvidence = {
    artifactType: "evidence", schemaVersion: "3.0.0", producerVersion: "1.0.0",
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

  it.each(["1.0.0", "2.0.0"])("rejects evidence still declaring schemaVersion %s", (schemaVersion) => {
    expect(validateArtifact("evidence", { ...logEvidence, schemaVersion }).valid).toBe(false);
  });
});

/** Evidence 3.0.0 adds a THIRD `provenance` branch, `runner-report`, and the matching `kind`. Lane 2's
 *  runner emits one raw JSON report for a whole execution; no pre-3.0.0 branch could hold it, because
 *  both hard-require `url`, `browser` and `build`, and a reporter payload has none of the three.
 *  Reusing `log` would have meant inventing them — fabricating provenance to satisfy a schema is the
 *  exact failure this contract exists to prevent, and the same one 2.0.0 removed from screenshot
 *  geometry.
 *
 *  The branch is deliberately NARROW. It records what the RUNTIME OBSERVED about the process (which
 *  runner, which version, what it exited with, when it was captured) and nothing the caller typed:
 *  there is no `command`/`argv` field, because lane 2's arguments come from the caller and can carry a
 *  resolved token or password, and CONTEXT.md:371 forbids resolved secret values in artifacts. An
 *  immutable, checksummed artifact is the worst possible place to discover one. There is no `signal`
 *  field either, and nothing writes this branch yet: a runner killed by a signal produced no
 *  trustworthy result, so the producer that lands in a later task must refuse such a run outright
 *  rather than record a half-execution — which is why no field here can describe one.
 *
 *  `additionalProperties: false` is what makes both of those absences ENFORCED rather than merely
 *  conventional, and the `url`/`browser`/`build` rejections below are what prove this is a
 *  discriminated THIRD case rather than a loophole that widens the existing two. */
describe("evidence schema 3.0.0 (runner-report)", () => {
  const runnerReport = {
    artifactType: "evidence", schemaVersion: "3.0.0", producerVersion: "1.0.0",
    evidenceId: "01K0ABCDEFGHJKMNPQRSTVWXYZ", runId: "20260723T123456Z-a1b2c3",
    subject: { kind: "observed-execution", executionId: "EXEC-1" },
    kind: "runner-report", capturedAt: "2026-07-23T12:34:56.000Z",
    sha256: "a".repeat(64), relativePath: "evidence/report.json", mediaType: "application/json",
    binaryArtifactIds: ["binary-1"],
    binaryArtifacts: [{ id: "binary-1", relativePath: "evidence/report.json", sha256: "a".repeat(64), mediaType: "application/json" }],
    provenance: { captureType: "runner-report", runner: "playwright", runnerVersion: "1.54.1", exitCode: 1, capturedAt: "2026-07-23T12:34:56.000Z" },
  };

  it("accepts a reporter-shaped evidence value", () => {
    expect(validateArtifact("evidence", runnerReport).valid).toBe(true);
  });

  // The proof that the branch is a discriminated THIRD case: the very fields the other two REQUIRE are
  // the ones this one forbids, so a runner report cannot be quietly widened into a browser capture.
  it.each(["url", "browser", "build"] as const)("rejects a runner report that also declares %s", (field) => {
    expect(validateArtifact("evidence", { ...runnerReport, provenance: { ...runnerReport.provenance, [field]: "about:blank" } }).valid).toBe(false);
  });

  it.each(["dimensions", "dpr", "scroll", "clip", "viewport", "cssBoxes", "pixelBoxes", "locator", "annotationLabels"] as const)(
    "rejects a runner report carrying screenshot geometry (%s)",
    (field) => {
      const geometry: Record<string, unknown> = { dimensions: { width: 1, height: 1 }, dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 1, height: 1 }, cssBoxes: [], pixelBoxes: [], locator: "#root", annotationLabels: ["label"] };
      expect(validateArtifact("evidence", { ...runnerReport, provenance: { ...runnerReport.provenance, [field]: geometry[field] } }).valid).toBe(false);
    },
  );

  // The secret-leak guard, pinned as a test so a later contributor cannot "helpfully" add it back
  // without this reddening first. See the block comment above and CONTEXT.md:371.
  it.each(["command", "argv"] as const)("rejects a runner report recording what the caller typed (%s)", (field) => {
    expect(validateArtifact("evidence", { ...runnerReport, provenance: { ...runnerReport.provenance, [field]: ["npx", "playwright", "test"] } }).valid).toBe(false);
  });

  it.each(["captureType", "runner", "runnerVersion", "exitCode", "capturedAt"] as const)("rejects a runner report missing %s", (field) => {
    const provenance: Record<string, unknown> = { ...runnerReport.provenance };
    delete provenance[field];
    expect(validateArtifact("evidence", { ...runnerReport, provenance }).valid).toBe(false);
  });

  it.each(["runner", "runnerVersion"] as const)("rejects an empty %s, which would name nothing at all", (field) => {
    expect(validateArtifact("evidence", { ...runnerReport, provenance: { ...runnerReport.provenance, [field]: "" } }).valid).toBe(false);
  });

  it("rejects a non-integer exit code, which no process ever returned", () => {
    expect(validateArtifact("evidence", { ...runnerReport, provenance: { ...runnerReport.provenance, exitCode: 1.5 } }).valid).toBe(false);
  });

  it("accepts exit code 0, so a fully passing observed execution is still evidenceable", () => {
    expect(validateArtifact("evidence", { ...runnerReport, provenance: { ...runnerReport.provenance, exitCode: 0 } }).valid).toBe(true);
  });

  const evidenceKindEnum = () => (schemas.evidence as { properties: { kind: { enum: unknown[] } } }).properties.kind.enum;
  const manifestCaptureTypeEnum = () => (schemas["artifact-manifest"] as { properties: { artifacts: { items: { properties: { captureType: { enum: unknown[] } } } } } })
    .properties.artifacts.items.properties.captureType.enum;

  /** SUBSET assertions, not full-equality pins: `kind` and `captureType` each gain `runner-report` and
   *  lose nothing, so lane 1's five capture kinds (plus `evidence-gap`, which only `kind` has) must all
   *  still be members. A full-equality pin against hardcoded literals is a test nobody updates; these
   *  two fail only for the drift they name — a lane-1 member quietly disappearing behind lane 2's
   *  addition, from either list, including from BOTH at once (which the derived cross-pin below cannot
   *  see, because dropping the same member from both keeps the two lists equal to each other). */
  it("adds runner-report to the kind vocabulary without removing any lane-1 kind", () => {
    expect(evidenceKindEnum()).toEqual(expect.arrayContaining(["screenshot", "trace", "console", "network", "log", "evidence-gap", "runner-report"]));
  });

  it("adds runner-report to the manifest captureType vocabulary without removing any lane-1 capture type", () => {
    expect(manifestCaptureTypeEnum()).toEqual(expect.arrayContaining(["screenshot", "trace", "console", "network", "log", "runner-report"]));
  });

  /** The CROSS-PIN, and the one assertion here that is DERIVED rather than hardcoded. The two
   *  assertions above check each enum against its own literal list, which is exactly what the
   *  `captureType` duplication made dangerous: a seventh capture type added to `evidence.kind` and
   *  forgotten in `artifact-manifest.captureType` passes both of them untouched. This one relates the
   *  two lists to each other, so it fails precisely then — and in the mirror case too.
   *
   *  The invariant it encodes is `matchesEvidencePrimary`'s (`src/core/artifact-record.ts`): a
   *  descriptor's `kind`, its `provenance.captureType`, and the manifest record's `captureType` must be
   *  the same token, so a capture kind with no manifest spelling could never be registered, and a
   *  manifest captureType with no matching kind could never be described. Equality, not subset.
   *
   *  `evidence-gap` is subtracted because it is the one `kind` that names no capture at all: it marks
   *  an evidence item standing in for an observation that could not be made, so it never labels a
   *  binary and has no manifest `captureType` counterpart. Sorted, so a pure reordering of either enum
   *  — which changes nothing — does not fail; a genuine divergence names the offending member. */
  it("keeps every capture kind spellable as a manifest captureType, and vice versa", () => {
    const kinds = evidenceKindEnum();

    expect(kinds).toContain("evidence-gap");
    expect(kinds.filter((kind) => kind !== "evidence-gap").sort()).toEqual([...manifestCaptureTypeEnum()].sort());
  });

  // Lane 1 is unchanged by the third branch: each still validates against the branch it always used.
  // This is the other half of the subset pins above — the vocabulary keeps the members AND the shapes
  // they name. (`screenshot` is covered by the 3.0.0 block's own geometry tests, not repeated here.)
  it.each(["trace", "console", "network", "log"] as const)("still accepts a lane-1 %s capture", (captureType) => {
    expect(validateArtifact("evidence", {
      ...runnerReport, kind: captureType,
      subject: { kind: "attempt", attemptId: "01K0ABCDEFGHJKMNPQRSTVWXYZ", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" },
      provenance: { captureType, url: "about:blank", browser: "chromium", build: "test", capturedAt: "2026-07-23T12:34:56.000Z" },
    }).valid).toBe(true);
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
describe("test-result schema 3.0.0 (observed engine)", () => {
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
 *  coverage, and the per-entry identity + status shape the coverage readers flatten.
 *
 *  Since 3.0.0 an entry also declares the Execution Surface it actually ran on, plus (on the browser
 *  surface only) the engine and viewport it ran at. Before that the readers stamped every entry
 *  `browser` and inherited the viewport from the bound test case's DECLARATION — two labels agreeing
 *  with nothing measured between them, the shape CONTEXT.md:441-442 exists to kill. */
describe("test-result-batch schema (Runtime-Observed Execution)", () => {
  /** Everything an entry carries no matter which Execution Surface it observed. */
  const surfacelessEntry = {
    entryId: "ENTRY-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "TC-1--INSTANCE-1",
    status: "PASSED", failureClassification: "NONE",
    steps: [{ stepId: "step-1", status: "PASSED", durationMs: 1 }],
  };
  /** Plus the two only the browser surface owns — the same pair `coverage-obligation` conditions on. */
  const entry = { ...surfacelessEntry, executionSurface: "browser", observedEngine: "chromium", viewport: { width: 1440, height: 900 } };
  const batch = {
    artifactType: "test-result-batch", schemaVersion: "4.0.0", producerVersion: "1.0.0",
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

  it("rejects a batch declaring any schemaVersion other than 4.0.0", () => {
    expect(validateArtifact("test-result-batch", { ...batch, schemaVersion: "1.0.0" }).valid).toBe(false);
    // 2.0.0 is the shape whose entries carried no Execution Surface at all, so both readers stamped
    // them `browser`. A hard break with no migration layer: that shape must stop validating outright.
    expect(validateArtifact("test-result-batch", { ...batch, schemaVersion: "2.0.0" }).valid).toBe(false);
    // 3.0.0 is the shape whose identity fields carried no colon pattern, so a joined triple could
    // collide across artifacts. A hard break with no migration layer: superseded, not merely stale.
    expect(validateArtifact("test-result-batch", { ...batch, schemaVersion: "3.0.0" }).valid).toBe(false);
  });

  it.each(["entryId", "testCaseId", "testCaseRevisionId", "testCaseInstanceId", "status", "failureClassification", "executionSurface", "steps"] as const)("rejects an entry missing %s", (field) => {
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

  it("rejects an entry declaring a surface the Execution Surface enum does not name", () => {
    expect(validateArtifact("test-result-batch", { ...batch, entries: [{ ...entry, executionSurface: "e2e" }] }).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "enum" })]),
    );
  });

  /** The obligation's surface enum is pinned to `executionSurfaces` in coverage.ts, exactly. The
   *  entry's is a strict SUBSET of the same list, not an equality: `manual` is the one member missing.
   *  A `test-result-batch` is a git anchor (`commitSha` + `specTreeSha256`, ADR-0010) binding the
   *  checksummed spec tree an OBSERVED execution ran against, and a human's manual evaluation has no
   *  spec tree to hash — so a machine-written entry claiming `manual` would be incoherent with the
   *  artifact carrying it, while an obligation may still declare it and stay authorable-but-unmet
   *  (CONTEXT.md:445). `toEqual` below names the offending member on failure if either enum drifts:
   *  the obligation from `executionSurfaces`, or the entry from `executionSurfaces` minus `manual`. */
  it("declares a strict SUBSET of the coverage-obligation Execution Surface enum, missing exactly manual", () => {
    const entryEnum = (schemas["test-result-batch"] as { properties: { entries: { items: { properties: { executionSurface: { enum: unknown[] } } } } } })
      .properties.entries.items.properties.executionSurface.enum;
    const obligationEnum = (schemas["coverage-obligation"] as { properties: { executionSurface: { enum: unknown[] } } })
      .properties.executionSurface.enum;

    expect(obligationEnum).toEqual([...executionSurfaces]);
    expect(entryEnum).toEqual(executionSurfaces.filter((surface) => surface !== "manual"));
  });

  /** The one member the entry's enum must never regain. `manual` is a valid `coverage-obligation`
   *  surface (see below) but not a valid ENTRY surface — see the enum's own description in the schema
   *  for why. This is the same drift pin `accessibilityMethod` carries below, applied to the narrower
   *  direction: a member present on the obligation's list and absent from the entry's is a surface an
   *  obligation may declare that a machine-written entry can never credit, which is the point. */
  it("rejects an entry declaring executionSurface manual", () => {
    expect(validateArtifact("test-result-batch", { ...batch, entries: [{ ...surfacelessEntry, executionSurface: "manual" }] }).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ instancePath: "/entries/0/executionSurface", keyword: "enum" })]),
    );
  });

  /** The browser surface's two dimensions, conditioned to the same EFFECT as `coverage-obligation`'s
   *  `browser` + `viewport`: REQUIRED on the browser surface, FORBIDDEN on every other one.
   *
   *  Spelled `if`/`then`/`else` on the entry schema rather than as that schema's two-branch `allOf`,
   *  and deliberately: `json-schema-to-typescript` collapses a NESTED schema carrying `allOf` to a bare
   *  `{ [k: string]: unknown }` index signature, so copying the obligation's shape here silently
   *  deleted every entry field from `src/contracts/generated/test-result-batch.d.ts` while
   *  `check:generated` stayed green. `coverage-obligation` does not pay that cost because its
   *  conditional sits at the schema ROOT. The `else` branch is also strictly tighter than the
   *  obligation's negative `if`: it fires when `executionSurface` is absent as well as when it is
   *  non-browser, which only matters for a record the `required` list already rejects.
   *
   *  `observedEngine` was unconditionally required until 3.0.0, which was defensible only while every
   *  entry was assumed to be a browser entry. An `api` or `unit` suite has no browser engine, so
   *  requiring one would force a producer to write a value it did not observe — the same fabrication
   *  Phase 5 removed from evidence geometry, in a checksummed audit record. Forbidding it is what makes
   *  "this entry names no engine" the only thing a non-browser entry can say. */
  it.each(["observedEngine", "viewport"] as const)("requires %s on a browser entry", (field) => {
    const incomplete: Record<string, unknown> = { ...entry };
    delete incomplete[field];

    expect(validateArtifact("test-result-batch", { ...batch, entries: [incomplete] }).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "required" })]),
    );
  });

  // `manual` excluded: it is not a member of the entry's own enum (see the subset test above), so it
  // belongs with the rejection tests, not here.
  it.each(executionSurfaces.filter((surface) => surface !== "browser" && surface !== "manual"))("accepts a %s entry that names neither an engine nor a viewport", (surface) => {
    expect(validateArtifact("test-result-batch", { ...batch, entries: [{ ...surfacelessEntry, executionSurface: surface }] }).valid).toBe(true);
  });

  it.each([
    ["an observed engine", { observedEngine: "chromium" }],
    ["a viewport", { viewport: { width: 1440, height: 900 } }],
  ] as const)("forbids %s on a non-browser entry", (_label, override) => {
    expect(validateArtifact("test-result-batch", { ...batch, entries: [{ ...surfacelessEntry, executionSurface: "api", ...override }] }).valid).toBe(false);
  });

  it("rejects a browser entry whose viewport is not a positive integer geometry", () => {
    for (const viewport of [{ width: 1440 }, { width: 1440, height: 0 }, { width: 1440.5, height: 900 }, { width: 1440, height: 900, dpr: 2 }]) {
      expect(validateArtifact("test-result-batch", { ...batch, entries: [{ ...entry, viewport }] }).valid).toBe(false);
    }
  });
});

/** `executionSurface` makes the Execution Surface an explicit, declared field so that a surface the
 *  runtime cannot execute is still authorable and therefore still *countable* (CONTEXT.md:443-445).
 *  `browser` and `viewport` describe the browser surface only; on every other surface they are
 *  FORBIDDEN, not merely optional, for the same reason Phase 5 forbade geometry on non-screenshot
 *  evidence — an optional field lets a fabricated value survive into a checksummed audit record.
 *
 *  It arrived as `coverage-obligation` 2.0.0; the fixtures below say `4.0.0` because the
 *  `accessibilityMethod` enum and the identity `pattern` each broke the same schema again since. The
 *  version in this block's name is deliberately the shipped one, not the one this field arrived in. */
describe("coverage-obligation schema 4.0.0 (executionSurface)", () => {
  /** Everything an obligation carries no matter which surface it declares. */
  const common = {
    artifactType: "coverage-obligation", schemaVersion: "4.0.0", producerVersion: "1.0.0",
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

/** CONTEXT.md:437 — an Accessibility Obligation "distinguishes automated analysis, keyboard
 *  evaluation, screen-reader evaluation, and cognitive/manual review". Those four categories are the
 *  whole vocabulary, so `accessibilityMethod` is an enum over them plus `null`, which is how an
 *  obligation says it names NO accessibility method at all. A free-form string is no longer a legal
 *  value anywhere: an arbitrary label in a checksummed audit record is a claim nothing can check, and
 *  (until Task 35) label equality is exactly what credits the obligation. */
describe("accessibilityMethod is an enum (coverage-obligation 4.0.0, test-case 3.0.0)", () => {
  const obligation = {
    artifactType: "coverage-obligation", schemaVersion: "4.0.0", producerVersion: "1.0.0",
    obligationId: "COV-A11Y", requirementId: "REQ-1", requirementAnalysisArtifactId: "RA-1",
    role: "member", behavior: "sign in", executionSurface: "manual",
    accessibilityMethod: null, risk: "high", required: true, outcome: "account page opens",
  };
  const testCase = {
    artifactType: "test-case", schemaVersion: "3.0.0", producerVersion: "1.0.0",
    testCaseId: "TC-1", revisionId: "REV-1", instanceId: "TC-1--INSTANCE-1", title: "A valid test case",
    steps: [{ id: "step-1", action: "navigate", sideEffect: "none" }],
    coverage: {
      requirementId: "REQ-1", role: "member", behavior: "sign in", browser: "chromium",
      viewport: { width: 1440, height: 900 }, accessibilityMethod: null, risk: "medium", outcome: "account opens",
    },
  };
  const withMethod = (method: unknown) => ({
    obligation: { ...obligation, accessibilityMethod: method },
    testCase: { ...testCase, coverage: { ...testCase.coverage, accessibilityMethod: method } },
  });

  it.each(accessibilityMethods)("accepts %s on both schemas", (method) => {
    const artifacts = withMethod(method);
    expect(validateArtifact("coverage-obligation", artifacts.obligation).valid).toBe(true);
    expect(validateArtifact("test-case", artifacts.testCase).valid).toBe(true);
  });

  it("keeps null as the representation for no declared accessibility method", () => {
    expect(validateArtifact("coverage-obligation", obligation).valid).toBe(true);
    expect(validateArtifact("test-case", testCase).valid).toBe(true);
  });

  // "manual-keyboard" is the label an existing fixture carried; it is not one of CONTEXT.md:437's
  // four categories, and the enum is what makes that visible instead of silently creditable.
  it.each(["manual-keyboard", "axe", "a11y", "", "none", "NONE", "Keyboard"] as const)(
    "rejects the free-form value %o on both schemas",
    (method) => {
      const artifacts = withMethod(method);
      expect(validateArtifact("coverage-obligation", artifacts.obligation).errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ instancePath: "/accessibilityMethod", keyword: "enum" })]),
      );
      expect(validateArtifact("test-case", artifacts.testCase).errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ instancePath: "/coverage/accessibilityMethod", keyword: "enum" })]),
      );
    },
  );

  /** Both bumps are independently breaking: a previously-valid free-form label is now invalid, so a
   *  2.0.0 obligation or a 1.0.0 test case cannot be reinterpreted under the new contract. Hard break,
   *  no migration layer. */
  it("rejects the superseded schemaVersion on each schema (hard break, no migration layer)", () => {
    expect(validateArtifact("coverage-obligation", { ...obligation, schemaVersion: "2.0.0" }).valid).toBe(false);
    expect(validateArtifact("test-case", { ...testCase, schemaVersion: "1.0.0" }).valid).toBe(false);
  });

  it("keeps the TypeScript mirror equal to the schema enum", () => {
    const schemaEnum = (schemas["coverage-obligation"] as { properties: { accessibilityMethod: { enum: unknown[] } } })
      .properties.accessibilityMethod.enum;
    const testCaseEnum = (schemas["test-case"] as { properties: { coverage: { properties: { accessibilityMethod: { enum: unknown[] } } } } })
      .properties.coverage.properties.accessibilityMethod.enum;

    expect(schemaEnum).toEqual([...accessibilityMethods, null]);
    expect(testCaseEnum).toEqual([...accessibilityMethods, null]);
  });
});

/** A **Human Attestation** is "an identified person's immutable signed claim that an evaluation no
 *  machine performed was actually carried out" (CONTEXT.md:143-145). Distinct from an
 *  `approval-decision` by that glossary entry's own `_Avoid_` line, and shaped accordingly: it names
 *  the exact obligation it attests to BY CHECKSUM (so the claim is independently auditable against
 *  immutable bytes, not against whatever the manifest resolves later), the person and moment it was
 *  made, and — the substance — a `statement` of what was actually done. */
describe("human-attestation schema 2.0.0", () => {
  const attestation = {
    artifactType: "human-attestation", schemaVersion: "2.0.0", producerVersion: "1.0.0",
    attestationId: "ATTESTATION-1", runId: "20260723T123456Z-a1b2c3", obligationId: "COV-A11Y",
    obligationSha256: "b".repeat(64), method: "keyboard",
    attestedBy: "accessibility-reviewer@example.test", attestedAt: "2026-07-25T09:00:00.000Z",
    statement: "Navigated the checkout flow using only the keyboard; every control was reachable and focus was visible.",
  };

  it("accepts a well-formed manual attestation", () => {
    expect(validateArtifact("human-attestation", attestation).valid).toBe(true);
  });

  it.each(manualAccessibilityMethods)("accepts the manual method %s", (method) => {
    expect(validateArtifact("human-attestation", { ...attestation, method }).valid).toBe(true);
  });

  /** The category error the brief names: a person cannot attest to having personally performed
   *  automated analysis. The SCHEMA says so, rather than leaving it to a rule that a future producer
   *  could bypass. */
  it("rejects an attestation claiming automated-analysis", () => {
    expect(validateArtifact("human-attestation", { ...attestation, method: "automated-analysis" }).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ instancePath: "/method", keyword: "enum" })]),
    );
  });

  it("rejects an attestation declaring no method at all", () => {
    expect(validateArtifact("human-attestation", { ...attestation, method: null }).valid).toBe(false);
  });

  it.each(["artifactType", "schemaVersion", "producerVersion", "attestationId", "runId", "obligationId", "obligationSha256", "method", "attestedBy", "attestedAt", "statement"] as const)(
    "rejects an attestation missing %s",
    (field) => {
      const invalid: Record<string, unknown> = { ...attestation };
      delete invalid[field];
      expect(validateArtifact("human-attestation", invalid).errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ keyword: "required" })]),
      );
    },
  );

  it("rejects unknown properties", () => {
    expect(validateArtifact("human-attestation", { ...attestation, approved: true }).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "additionalProperties" })]),
    );
  });

  /** An attestation whose statement is empty — or a placeholder token — is not evidence of anything:
   *  it records that somebody pressed a button, not what evaluation they carried out. */
  it.each(["", " ", "ok", "done", "yes", "LGTM", "keyboard tested"] as const)(
    "rejects the substanceless statement %o",
    (statement) => {
      expect(validateArtifact("human-attestation", { ...attestation, statement }).valid).toBe(false);
    },
  );

  it("rejects an obligation checksum that is not a sha256", () => {
    expect(validateArtifact("human-attestation", { ...attestation, obligationSha256: "not-a-sha" }).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: "pattern" })]),
    );
  });

  it("rejects an attestedAt that is not a date-time", () => {
    expect(validateArtifact("human-attestation", { ...attestation, attestedAt: "yesterday" }).valid).toBe(false);
  });

  it("rejects any schemaVersion other than 2.0.0", () => {
    // 1.0.0 is the shape whose obligationId carried no colon pattern, so a joined triple could
    // collide across artifacts. A hard break with no migration layer: superseded, not merely stale.
    expect(validateArtifact("human-attestation", { ...attestation, schemaVersion: "1.0.0" }).valid).toBe(false);
  });

  it("keeps the TypeScript manual-method mirror equal to the schema's method enum", () => {
    const methodEnum = (schemas["human-attestation"] as { properties: { method: { enum: unknown[] } } }).properties.method.enum;

    expect(methodEnum).toEqual([...manualAccessibilityMethods]);
    expect(methodEnum).not.toContain("automated-analysis");
  });
});

/** The colon-collision class: a testCaseId/revisionId/instanceId (or equivalent identity) triple
 *  joined naively as "a:b:c" collides across artifacts whose components differ only in where the
 *  colon falls -- e.g. ("TC","R","A:B") and ("TC","R:A","B") produce the same joined string. That bug
 *  was fixed three times at the reader side (the observed-coverage reader, the checkpoint comparison,
 *  the regression decision store) while the data shape stayed free to produce it. Forbidding ":" in
 *  every identity-bearing field closes the class at the shape, making a colliding artifact
 *  unregisterable rather than relying on every reader to guard against it. */
describe("identity fields forbid a colon (closes the collision class at the data shape)", () => {
  const testCase = {
    artifactType: "test-case", schemaVersion: "3.0.0", producerVersion: "1.0.0",
    testCaseId: "TC-1", revisionId: "REV-1", instanceId: "TC-1--INSTANCE-1", title: "A valid test case",
    steps: [{ id: "step-1", action: "navigate", sideEffect: "none" }],
    coverage: {
      requirementId: "REQ-1", role: "member", behavior: "sign in", browser: "chromium",
      viewport: { width: 1440, height: 900 }, accessibilityMethod: null, risk: "medium", outcome: "account opens",
    },
  };

  it("rejects a test case whose identity components could rejoin to another case's", () => {
    expect(validateArtifact("test-case", { ...testCase, instanceId: "A:B" }).valid).toBe(false);
    expect(validateArtifact("test-case", { ...testCase, revisionId: "R:A" }).valid).toBe(false);
    expect(validateArtifact("test-case", { ...testCase, testCaseId: "TC:X" }).valid).toBe(false);
  });

  const testResult = {
    artifactType: "test-result", schemaVersion: "3.0.0", producerVersion: "1.0.0",
    attemptId: "01K0ABCDEFGHJKMNPQRSTVWXYZ", runId: "20260723T123456Z-a1b2c3",
    testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "TC-1--INSTANCE-1",
    status: "PASSED", failureClassification: "NONE", observedEngine: "chromium",
    steps: [{ stepId: "step-1", status: "PASSED", durationMs: 1 }],
    startedAt: "2026-07-23T12:34:56.000Z", finishedAt: "2026-07-23T12:35:56.000Z",
  };

  it("rejects a test result whose identity components could rejoin to another result's", () => {
    expect(validateArtifact("test-result", { ...testResult, testCaseId: "TC:X" }).valid).toBe(false);
    expect(validateArtifact("test-result", { ...testResult, testCaseRevisionId: "R:A" }).valid).toBe(false);
    expect(validateArtifact("test-result", { ...testResult, testCaseInstanceId: "A:B" }).valid).toBe(false);
  });

  const batch = {
    artifactType: "test-result-batch", schemaVersion: "4.0.0", producerVersion: "1.0.0",
    executionId: "EXEC-1", runId: "20260723T123456Z-a1b2c3",
    commitSha: "b".repeat(40), specTreeSha256: "c".repeat(64),
    startedAt: "2026-07-23T12:34:56.000Z", finishedAt: "2026-07-23T12:35:56.000Z",
    entries: [{
      entryId: "ENTRY-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "TC-1--INSTANCE-1",
      status: "PASSED", failureClassification: "NONE", executionSurface: "browser",
      observedEngine: "chromium", viewport: { width: 1440, height: 900 },
      steps: [{ stepId: "step-1", status: "PASSED", durationMs: 1 }],
    }],
  };

  it("rejects a test-result-batch entry whose identity components could rejoin to another entry's", () => {
    const entry = batch.entries[0];
    expect(validateArtifact("test-result-batch", { ...batch, entries: [{ ...entry, testCaseId: "TC:X" }] }).valid).toBe(false);
    expect(validateArtifact("test-result-batch", { ...batch, entries: [{ ...entry, testCaseRevisionId: "R:A" }] }).valid).toBe(false);
    expect(validateArtifact("test-result-batch", { ...batch, entries: [{ ...entry, testCaseInstanceId: "A:B" }] }).valid).toBe(false);
  });

  const obligation = {
    artifactType: "coverage-obligation", schemaVersion: "4.0.0", producerVersion: "1.0.0",
    obligationId: "COV-1", requirementId: "REQ-1", requirementAnalysisArtifactId: "RA-1",
    role: "member", behavior: "sign in", executionSurface: "manual",
    accessibilityMethod: null, risk: "high", required: true, outcome: "account page opens",
  };

  it("rejects a coverage obligation whose obligationId could rejoin to another's", () => {
    expect(validateArtifact("coverage-obligation", { ...obligation, obligationId: "COV:1" }).valid).toBe(false);
  });

  const evidenceGap = {
    artifactType: "evidence-gap", schemaVersion: "2.0.0", producerVersion: "1.0.0",
    evidenceGapId: "GAP-1", runId: "20260723T123456Z-a1b2c3", scope: "operational",
    reason: "The upstream system redacted the response.",
    affectedClaim: "The order was persisted successfully.",
  };

  it("rejects an evidence gap whose evidenceGapId could rejoin to another's", () => {
    expect(validateArtifact("evidence-gap", { ...evidenceGap, evidenceGapId: "GAP:1" }).valid).toBe(false);
  });

  const attestation = {
    artifactType: "human-attestation", schemaVersion: "2.0.0", producerVersion: "1.0.0",
    attestationId: "ATTESTATION-1", runId: "20260723T123456Z-a1b2c3", obligationId: "COV-A11Y",
    obligationSha256: "b".repeat(64), method: "keyboard",
    attestedBy: "accessibility-reviewer@example.test", attestedAt: "2026-07-25T09:00:00.000Z",
    statement: "Navigated the checkout flow using only the keyboard; every control was reachable and focus was visible.",
  };

  it("rejects a human attestation whose obligationId could rejoin to another's", () => {
    expect(validateArtifact("human-attestation", { ...attestation, obligationId: "COV:1" }).valid).toBe(false);
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
