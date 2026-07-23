/* This file is generated from shared/schemas. Do not edit manually. */

export interface CoverageObligation {
  artifactType: "coverage-obligation";
  schemaVersion: "1.0.0";
  producerVersion: string;
  obligationId: string;
  requirementId: string;
  requirementAnalysisArtifactId: string;
  role: string;
  behavior: string;
  browser: string;
  viewport: {
    width: number;
    height: number;
  };
  accessibilityMethod: string | null;
  risk: "low" | "medium" | "high" | "critical";
  required: boolean;
  outcome: string;
}
