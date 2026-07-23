/* This file is generated from shared/schemas. Do not edit manually. */

export interface RequirementAnalysis {
  artifactType: "requirement-analysis";
  schemaVersion: "1.0.0";
  producerVersion: string;
  requirementAnalysisId: string;
  /**
   * @minItems 1
   */
  statements: [
    {
      requirementId: string;
      sourceProvenance: {
        kind: "user" | "code" | "documentation" | "agent";
        reference: string;
        capturedAt?: string;
      };
      normalizedText: string;
      authority: "AUTHORITATIVE" | "INFERRED" | "ASSUMED" | "CONFLICTING";
      role: string;
      rules: string[];
      risks: string[];
      assumptions: string[];
      openQuestions: string[];
    },
    ...{
      requirementId: string;
      sourceProvenance: {
        kind: "user" | "code" | "documentation" | "agent";
        reference: string;
        capturedAt?: string;
      };
      normalizedText: string;
      authority: "AUTHORITATIVE" | "INFERRED" | "ASSUMED" | "CONFLICTING";
      role: string;
      rules: string[];
      risks: string[];
      assumptions: string[];
      openQuestions: string[];
    }[]
  ];
}
