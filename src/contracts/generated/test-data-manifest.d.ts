/* This file is generated from shared/schemas. Do not edit manually. */

export interface TestDataManifest {
  artifactType: "test-data-manifest";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  resources: {
    id: string;
    ownerRunId: string;
    cleanupAction: string;
  }[];
}
