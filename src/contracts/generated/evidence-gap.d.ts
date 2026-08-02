/* This file is generated from shared/schemas. Do not edit manually. */

export type EvidenceGap = {
  [k: string]: unknown | undefined;
} & {
  artifactType: "evidence-gap";
  evidenceGapId: string;
  schemaVersion: "2.0.0";
  producerVersion: string;
  runId: string;
  scope: "attempt" | "operational";
  attemptId?: string;
  testCaseId?: string;
  testCaseRevisionId?: string;
  testCaseInstanceId?: string;
  reason: string;
  affectedClaim: string;
};
