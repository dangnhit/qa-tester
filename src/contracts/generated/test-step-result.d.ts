/* This file is generated from shared/schemas. Do not edit manually. */

export interface TestStepResult {
  artifactType: "test-step-result";
  schemaVersion: "1.0.0";
  producerVersion: string;
  attemptId: string;
  stepId: string;
  status: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
  durationMs: number;
}
