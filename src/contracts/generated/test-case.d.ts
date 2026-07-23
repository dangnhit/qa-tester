/* This file is generated from shared/schemas. Do not edit manually. */

export interface TestCase {
  artifactType: "test-case";
  schemaVersion: "1.0.0";
  producerVersion: string;
  testCaseId: string;
  revisionId: string;
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
}
