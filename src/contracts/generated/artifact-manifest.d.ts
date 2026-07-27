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
      | "test-result-batch"
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
      | "approval-decision"
      | "exploration-charter"
      | "retest-result"
      | "regression-selection"
      | "change-scope"
      | "workflow-checkpoint"
      | "exploratory-finding"
      | "human-attestation";
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
