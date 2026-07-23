/* This file is generated from shared/schemas. Do not edit manually. */

export interface EvidenceGap {
  artifactType: "evidence-gap";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  reason: string;
  affectedClaim: string;
}
