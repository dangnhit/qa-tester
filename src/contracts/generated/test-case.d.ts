/* This file is generated from shared/schemas. Do not edit manually. */

export type Strings = string[];

export interface TestCase {
  artifactType: "test-case";
  schemaVersion: "2.0.0";
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
    /**
     * Same enum, same reason as coverage-obligation.accessibilityMethod: CONTEXT.md:437's four categories, or null for none declared. Both sides must be constrained because the coverage matcher compares this value to the obligation's, so a free-form label here would reintroduce exactly the free-form value the obligation no longer accepts.
     */
    accessibilityMethod: "automated-analysis" | "keyboard" | "screen-reader" | "cognitive-manual" | null;
    risk: "low" | "medium" | "high" | "critical";
    outcome: string;
  };
}
