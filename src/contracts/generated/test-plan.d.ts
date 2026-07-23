/* This file is generated from shared/schemas. Do not edit manually. */

export interface TestPlan {
  artifactType: "test-plan";
  schemaVersion: "1.0.0";
  producerVersion: string;
  testPlanId: string;
  /**
   * @minItems 1
   */
  testCases: [
    {
      testCaseId: string;
      title: string;
      /**
       * @minItems 1
       */
      expectedResults: [
        {
          id: string;
          requirementId: string;
          authority: "AUTHORITATIVE" | "INFERRED" | "ASSUMED" | "CONFLICTING";
          text: string;
        },
        ...{
          id: string;
          requirementId: string;
          authority: "AUTHORITATIVE" | "INFERRED" | "ASSUMED" | "CONFLICTING";
          text: string;
        }[]
      ];
      /**
       * @minItems 1
       */
      steps: [
        {
          id: string;
          action: string;
          sideEffect: "none" | "reversible" | "external" | "destructive";
          cleanup?: {
            declared: boolean;
          };
        },
        ...{
          id: string;
          action: string;
          sideEffect: "none" | "reversible" | "external" | "destructive";
          cleanup?: {
            declared: boolean;
          };
        }[]
      ];
      dslValid: boolean;
      openQuestions: string[];
    },
    ...{
      testCaseId: string;
      title: string;
      /**
       * @minItems 1
       */
      expectedResults: [
        {
          id: string;
          requirementId: string;
          authority: "AUTHORITATIVE" | "INFERRED" | "ASSUMED" | "CONFLICTING";
          text: string;
        },
        ...{
          id: string;
          requirementId: string;
          authority: "AUTHORITATIVE" | "INFERRED" | "ASSUMED" | "CONFLICTING";
          text: string;
        }[]
      ];
      /**
       * @minItems 1
       */
      steps: [
        {
          id: string;
          action: string;
          sideEffect: "none" | "reversible" | "external" | "destructive";
          cleanup?: {
            declared: boolean;
          };
        },
        ...{
          id: string;
          action: string;
          sideEffect: "none" | "reversible" | "external" | "destructive";
          cleanup?: {
            declared: boolean;
          };
        }[]
      ];
      dslValid: boolean;
      openQuestions: string[];
    }[]
  ];
}
