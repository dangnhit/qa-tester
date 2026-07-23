/* This file is generated from shared/schemas. Do not edit manually. */

export interface TestCase {
  artifactType: "test-case";
  schemaVersion: "1.0.0";
  producerVersion: string;
  testCaseId: string;
  revisionId: string;
  instanceId: string;
  title: string;
  execution?: {
    approval: "APPROVED";
    testPlanArtifactId: string;
    browserDsl: {
      [k: string]: unknown | undefined;
    };
  };
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
