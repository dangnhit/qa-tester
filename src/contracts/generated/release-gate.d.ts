/* This file is generated from shared/schemas. Do not edit manually. */

export interface ReleaseGate {
  artifactType: "release-gate";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  sourceArtifacts: {
    id: string;
    sha256: string;
    type: string;
  }[];
  recommendation: "READY" | "READY_WITH_RISKS" | "NOT_READY";
  ruleInputs: {
    [k: string]: unknown | undefined;
  };
  verdicts: {
    rule: string;
    passed: boolean;
    reason: string;
  }[];
}
