/* This file is generated from shared/schemas. Do not edit manually. */

export type CoverageObligation = {
  [k: string]: unknown | undefined;
} & {
  artifactType: "coverage-obligation";
  schemaVersion: "2.0.0";
  producerVersion: string;
  obligationId: string;
  requirementId: string;
  requirementAnalysisArtifactId: string;
  role: string;
  behavior: string;
  executionSurface: "browser" | "api" | "unit" | "integration" | "performance" | "security" | "manual";
  browser?: string;
  viewport?: {
    width: number;
    height: number;
  };
  accessibilityMethod: string | null;
  risk: "low" | "medium" | "high" | "critical";
  required: boolean;
  outcome: string;
};
