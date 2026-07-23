/* This file is generated from shared/schemas. Do not edit manually. */

export interface EnvironmentProfile {
  artifactType: "environment-profile";
  schemaVersion: "1.0.0";
  producerVersion: string;
  environmentProfileId: string;
  name: string;
  classification: "local" | "test" | "staging" | "production";
  baseUrl: string;
  productionReadOnly: boolean;
  evidenceProtection?: {
    protected?: boolean;
    domSelectors?: string[];
    regions?: {
      x: number;
      y: number;
      width: number;
      height: number;
    }[];
  };
}
