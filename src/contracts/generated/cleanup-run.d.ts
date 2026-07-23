/* This file is generated from shared/schemas. Do not edit manually. */

export interface CleanupRun {
  artifactType: "cleanup-run";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  sourceRunId: string;
  sourceTestDataManifestArtifactId: string;
  sourceTestDataManifestSha256: string;
  sourceTestDataManifest: TestDataManifest;
  resources: CleanupResource[];
}
export interface TestDataManifest {
  artifactType: "test-data-manifest";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  resources: Resource[];
}
export interface Resource {
  id: string;
  ownerRunId: string;
  cleanupAction: string;
}
export interface CleanupResource {
  id: string;
  ownerRunId: string;
  cleanupAction: string;
  status: "cleaned" | "failed";
  message?: string;
}
