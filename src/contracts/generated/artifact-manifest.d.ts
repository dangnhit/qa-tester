/* This file is generated from shared/schemas. Do not edit manually. */

export interface RunArtifactManifest {
  artifactType: "artifact-manifest";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  artifacts: {
    id: string;
    type:
      | "run-metadata"
      | "artifact-manifest"
      | "environment-profile"
      | "test-case"
      | "test-step-result"
      | "test-result"
      | "evidence"
      | "evidence-gap"
      | "bug-report"
      | "incident"
      | "release-gate"
      | "test-data-manifest"
      | "cleanup-run"
      | "qa-execution-report"
      | "requirement-analysis"
      | "coverage-obligation"
      | "test-plan"
      | "exploration-charter"
      | "retest-result"
      | "regression-selection"
      | "change-scope";
    relativePath: string;
    sha256: string;
    mediaType?: string;
    captureType?: "screenshot" | "trace" | "console" | "network" | "log";
    dimensions?: {
      width: number;
      height: number;
    };
    provenance: string;
    relationships: string[];
  }[];
}
