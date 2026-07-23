/* This file is generated from shared/schemas. Do not edit manually. */

export interface TestResult {
  artifactType: "test-result";
  schemaVersion: "1.0.0";
  producerVersion: string;
  attemptId: string;
  runId: string;
  testCaseId: string;
  testCaseRevisionId: string;
  status: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
  failureClassification: "PRODUCT_DEFECT" | "TEST_DEFECT" | "ENVIRONMENT_DEFECT" | "UNDETERMINED" | "NONE";
  startedAt: string;
  finishedAt: string;
}
