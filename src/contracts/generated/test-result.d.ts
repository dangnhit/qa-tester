/* This file is generated from shared/schemas. Do not edit manually. */

export interface TestResult {
  artifactType: "test-result";
  schemaVersion: "1.0.0";
  producerVersion: string;
  attemptId: string;
  runId: string;
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
  startedAt: string;
  finishedAt: string;
}
