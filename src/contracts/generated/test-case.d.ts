/* This file is generated from shared/schemas. Do not edit manually. */

export type Strings = string[];

export interface TestCase {
  artifactType: "test-case";
  schemaVersion: "1.0.0";
  producerVersion: string;
  testCaseId: string;
  revisionId: string;
  instanceId: string;
  title: string;
  /**
   * @minItems 1
   */
  steps: [
    {
      id: string;
      action: string;
      sideEffect: "none" | "reversible" | "external" | "destructive";
    },
    ...{
      id: string;
      action: string;
      sideEffect: "none" | "reversible" | "external" | "destructive";
    }[]
  ];
  regressionIndex?: {
    requirementIds: Strings;
    codeSurfaces: Strings;
    declaredDependencies: Strings;
    gitPaths: Strings;
    userScope: Strings;
  };
  coverage: {
    requirementId: string;
    role: string;
    behavior: string;
    browser: string;
    viewport: {
      width: number;
      height: number;
    };
    accessibilityMethod: string | null;
    risk: "low" | "medium" | "high" | "critical";
    outcome: string;
  };
}
