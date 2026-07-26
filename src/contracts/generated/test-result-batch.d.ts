/* This file is generated from shared/schemas. Do not edit manually. */

export interface TestResultBatch {
  artifactType: "test-result-batch";
  schemaVersion: "1.0.0";
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
