/* This file is generated from shared/schemas. Do not edit manually. */

export interface TestResultBatch {
  artifactType: "test-result-batch";
  schemaVersion: "4.0.0";
  producerVersion: string;
  executionId: string;
  runId: string;
  commitSha: string;
  specTreeSha256: string;
  startedAt: string;
  finishedAt: string;
  /**
   * @minItems 1
   */
  entries: [
    {
      entryId: string;
      testCaseId: string;
      testCaseRevisionId: string;
      testCaseInstanceId: string;
      status: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
      failureClassification: "PRODUCT_DEFECT" | "TEST_DEFECT" | "ENVIRONMENT_DEFECT" | "UNDETERMINED" | "NONE";
      /**
       * The Execution Surface this entry actually ran on, reported by the observed execution. A Runtime-Observed Execution is how the QA Runtime reaches every surface it does not execute itself (CONTEXT.md:444), so an entry is the only thing that can say which one it was; the bound test case does not declare a surface, and never should — a second declared label would only be a drift surface. Both coverage readers now read this field, with no fallback: an entry that names no recognized surface credits nothing. This enum is a strict SUBSET of coverage-obligation.executionSurface's, not an equality: it is missing exactly "manual". A test-result-batch's whole shape is a git anchor (commitSha + specTreeSha256, ADR-0010) binding the checksummed spec tree the OBSERVED execution ran against — the reason an observed execution may credit coverage at all — and a human's manual evaluation has no spec tree to hash, so a machine-written entry declaring "manual" would be incoherent with the artifact carrying it. An obligation may still declare "manual"; it stays authorable and, with no executor, explicitly unmet (CONTEXT.md:445). Do not re-add "manual" here to fix this asymmetry — it is deliberate.
       */
      executionSurface: "browser" | "api" | "unit" | "integration" | "performance" | "security";
      /**
       * The browser engine the observed execution reported for this entry. Same shape and same rule as test-result.observedEngine (CONTEXT.md:442): coverage is credited from the engine that ran, never from the one a test case declared. Browser-surface only since 3.0.0 — required there, FORBIDDEN elsewhere. An api or unit suite has no browser engine, so an unconditional requirement would force a producer to invent a value it never observed, which is the fabrication Phase 5 removed from evidence geometry.
       */
      observedEngine?: string;
      /**
       * The viewport the observed execution reported for this entry, and the other half of CONTEXT.md:441 ('never satisfied by another engine OR VIEWPORT'). Browser-surface only, on the same conditional as observedEngine. Unlike lane 1 — where createBrowserAttemptSession SETS the live context from test-case.coverage.viewport, making the declaration causally upstream of the geometry — nothing links a batch entry to the plan's declared viewport, so inheriting it would credit a geometry nothing rendered at.
       */
      viewport?: {
        width: number;
        height: number;
      };
      /**
       * @minItems 1
       */
      steps: [
        {
          stepId: string;
          status: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
          durationMs: number;
          failureOrigin?: "action" | "assertion";
          expectedResultId?: string;
        },
        ...{
          stepId: string;
          status: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
          durationMs: number;
          failureOrigin?: "action" | "assertion";
          expectedResultId?: string;
        }[]
      ];
      /**
       * @minItems 1
       */
      evidenceArtifactIds?: [string, ...string[]];
    },
    ...{
      entryId: string;
      testCaseId: string;
      testCaseRevisionId: string;
      testCaseInstanceId: string;
      status: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
      failureClassification: "PRODUCT_DEFECT" | "TEST_DEFECT" | "ENVIRONMENT_DEFECT" | "UNDETERMINED" | "NONE";
      /**
       * The Execution Surface this entry actually ran on, reported by the observed execution. A Runtime-Observed Execution is how the QA Runtime reaches every surface it does not execute itself (CONTEXT.md:444), so an entry is the only thing that can say which one it was; the bound test case does not declare a surface, and never should — a second declared label would only be a drift surface. Both coverage readers now read this field, with no fallback: an entry that names no recognized surface credits nothing. This enum is a strict SUBSET of coverage-obligation.executionSurface's, not an equality: it is missing exactly "manual". A test-result-batch's whole shape is a git anchor (commitSha + specTreeSha256, ADR-0010) binding the checksummed spec tree the OBSERVED execution ran against — the reason an observed execution may credit coverage at all — and a human's manual evaluation has no spec tree to hash, so a machine-written entry declaring "manual" would be incoherent with the artifact carrying it. An obligation may still declare "manual"; it stays authorable and, with no executor, explicitly unmet (CONTEXT.md:445). Do not re-add "manual" here to fix this asymmetry — it is deliberate.
       */
      executionSurface: "browser" | "api" | "unit" | "integration" | "performance" | "security";
      /**
       * The browser engine the observed execution reported for this entry. Same shape and same rule as test-result.observedEngine (CONTEXT.md:442): coverage is credited from the engine that ran, never from the one a test case declared. Browser-surface only since 3.0.0 — required there, FORBIDDEN elsewhere. An api or unit suite has no browser engine, so an unconditional requirement would force a producer to invent a value it never observed, which is the fabrication Phase 5 removed from evidence geometry.
       */
      observedEngine?: string;
      /**
       * The viewport the observed execution reported for this entry, and the other half of CONTEXT.md:441 ('never satisfied by another engine OR VIEWPORT'). Browser-surface only, on the same conditional as observedEngine. Unlike lane 1 — where createBrowserAttemptSession SETS the live context from test-case.coverage.viewport, making the declaration causally upstream of the geometry — nothing links a batch entry to the plan's declared viewport, so inheriting it would credit a geometry nothing rendered at.
       */
      viewport?: {
        width: number;
        height: number;
      };
      /**
       * @minItems 1
       */
      steps: [
        {
          stepId: string;
          status: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
          durationMs: number;
          failureOrigin?: "action" | "assertion";
          expectedResultId?: string;
        },
        ...{
          stepId: string;
          status: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
          durationMs: number;
          failureOrigin?: "action" | "assertion";
          expectedResultId?: string;
        }[]
      ];
      /**
       * @minItems 1
       */
      evidenceArtifactIds?: [string, ...string[]];
    }[]
  ];
}
