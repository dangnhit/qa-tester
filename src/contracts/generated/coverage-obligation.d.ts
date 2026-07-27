/* This file is generated from shared/schemas. Do not edit manually. */

export type CoverageObligation = {
  [k: string]: unknown | undefined;
} & {
  artifactType: "coverage-obligation";
  schemaVersion: "3.0.0";
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
  /**
   * The accessibility evaluation method this obligation requires, or null when it names none. The four members are exactly CONTEXT.md:437's categories; a free-form label is rejected because an arbitrary string in a checksummed audit record is a claim nothing can check. null is a distinct JSON type rather than a fifth member so that 'no accessibility method declared' can never be mistaken for a declared method matching its own label (CONTEXT.md:439).
   */
  accessibilityMethod: "automated-analysis" | "keyboard" | "screen-reader" | "cognitive-manual" | null;
  risk: "low" | "medium" | "high" | "critical";
  required: boolean;
  outcome: string;
};
