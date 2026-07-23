/* This file is generated from shared/schemas. Do not edit manually. */

export type Action =
  | {
      kind: "navigate";
      url: string;
    }
  | {
      kind: "click";
      locator: Locator;
    }
  | {
      kind: "fill";
      locator: Locator;
      value: string;
    }
  | {
      kind: "assert-text";
      locator: Locator;
      text: string;
    };
export type Locator =
  | {
      role: string;
      name?: string;
    }
  | {
      testId: string;
    }
  | {
      label: string;
    };

export interface TestPlan {
  artifactType: "test-plan";
  schemaVersion: "1.0.0";
  producerVersion: string;
  testPlanId: string;
  approvalPolicy: {
    mode: "auto-approve-safe" | "human-review";
  };
  approvalDecision?: {
    approved: boolean;
  };
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
          action: Action;
          sideEffect: "none" | "reversible" | "external" | "destructive";
          cleanup?: {
            declared: boolean;
          };
        },
        ...{
          id: string;
          action: Action;
          sideEffect: "none" | "reversible" | "external" | "destructive";
          cleanup?: {
            declared: boolean;
          };
        }[]
      ];
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
          action: Action;
          sideEffect: "none" | "reversible" | "external" | "destructive";
          cleanup?: {
            declared: boolean;
          };
        },
        ...{
          id: string;
          action: Action;
          sideEffect: "none" | "reversible" | "external" | "destructive";
          cleanup?: {
            declared: boolean;
          };
        }[]
      ];
      openQuestions: string[];
    }[]
  ];
}
