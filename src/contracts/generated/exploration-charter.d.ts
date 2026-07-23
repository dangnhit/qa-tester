/* This file is generated from shared/schemas. Do not edit manually. */

export interface ExplorationCharter {
  artifactType: "exploration-charter";
  schemaVersion: "1.0.0";
  producerVersion: string;
  charterId: string;
  runId: string;
  mission: string;
  /**
   * @minItems 1
   */
  scope: [string, ...string[]];
  /**
   * @minItems 1
   */
  roles: [string, ...string[]];
  /**
   * @minItems 1
   */
  heuristics: [string, ...string[]];
  /**
   * @minItems 1
   */
  safetyRules: [string, ...string[]];
  /**
   * @minItems 1
   */
  actions: [
    {
      actionId: string;
      target: string;
      kind: "navigate";
      sideEffect: "none" | "read" | "write";
      safetyRuleId: string;
      stopCondition?: string;
    },
    ...{
      actionId: string;
      target: string;
      kind: "navigate";
      sideEffect: "none" | "read" | "write";
      safetyRuleId: string;
      stopCondition?: string;
    }[]
  ];
  actionBudget: number;
  timeBudgetMinutes: number;
  /**
   * @minItems 1
   */
  stopConditions: [string, ...string[]];
}
