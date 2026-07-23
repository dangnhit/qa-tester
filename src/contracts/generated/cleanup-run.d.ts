/* This file is generated from shared/schemas. Do not edit manually. */

export interface CleanupRun {
  artifactType: "cleanup-run";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  sourceRunId: string;
  sourceTestDataManifestArtifactId: string;
  resources: {
    id: string;
    ownerRunId: string;
    cleanupAction: string;
    status: "cleaned" | "failed";
    message?: string;
  }[];
}
