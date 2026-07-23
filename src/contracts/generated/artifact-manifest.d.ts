/* This file is generated from shared/schemas. Do not edit manually. */

export interface RunArtifactManifest {
  artifactType: "artifact-manifest";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  artifacts: {
    id: string;
    type: string;
    relativePath: string;
    sha256: string;
    provenance: string;
    relationships: string[];
  }[];
}
