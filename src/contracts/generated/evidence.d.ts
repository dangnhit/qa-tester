/* This file is generated from shared/schemas. Do not edit manually. */

export interface EvidenceItem {
  artifactType: "evidence";
  schemaVersion: "1.0.0";
  producerVersion: string;
  evidenceId: string;
  runId: string;
  attemptId: string;
  kind: "screenshot" | "trace" | "console" | "network" | "log" | "evidence-gap";
  capturedAt: string;
  sha256: string;
  relativePath: string;
}
