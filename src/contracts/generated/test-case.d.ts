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
     * Same enum, same reason as coverage-obligation.accessibilityMethod: CONTEXT.md:437's four categories, or null for none declared. Nothing compares this value to an obligation's declared method — a declared label never satisfies an Accessibility Obligation by matching its own label (CONTEXT.md:439), so this field is informational only. It stays enum-constrained anyway so a free-form label here cannot reintroduce the same unauditable-claim problem the obligation's field was constrained to prevent.
     */
    accessibilityMethod: "automated-analysis" | "keyboard" | "screen-reader" | "cognitive-manual" | null;
    risk: "low" | "medium" | "high" | "critical";
    outcome: string;
  };
}
