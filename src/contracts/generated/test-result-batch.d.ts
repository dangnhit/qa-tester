/* This file is generated from shared/schemas. Do not edit manually. */

export interface TestResultBatch {
  artifactType: "test-result-batch";
  schemaVersion: "2.0.0";
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
       * The browser engine the observed execution reported for this entry. Same shape and same rule as test-result.observedEngine (CONTEXT.md:442): coverage is credited from the engine that ran, never from the one a test case declared. This artifact has no producer yet — Phase 7 owns it — so the field is required from the start rather than retrofitted onto existing instances.
       */
      observedEngine: string;
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
       * The browser engine the observed execution reported for this entry. Same shape and same rule as test-result.observedEngine (CONTEXT.md:442): coverage is credited from the engine that ran, never from the one a test case declared. This artifact has no producer yet — Phase 7 owns it — so the field is required from the start rather than retrofitted onto existing instances.
       */
      observedEngine: string;
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
