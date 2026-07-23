/* This file is generated from shared/schemas. Do not edit manually. */

export interface QAExecutionReport {
  artifactType: "qa-execution-report";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  generatedAt: string;
  releaseRecommendation: "READY" | "READY_WITH_RISKS" | "NOT_READY";
  summary: string;
}
