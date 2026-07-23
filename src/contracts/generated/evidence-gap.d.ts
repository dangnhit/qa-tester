/* This file is generated from shared/schemas. Do not edit manually. */

export interface EvidenceGap {
  artifactType: "evidence-gap";
  evidenceGapId: string;
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  attemptId: string;
  reason: string;
  affectedClaim: string;
}
