import { describe, expect, it } from "vitest";

import { assertExplorationCharter, createExploratoryFinding } from "../../src/exploratory/charter.js";

const charter = {
  charterId: "CHARTER-LOGIN", mission: "Explore sign-in recovery", scope: ["/login"], roles: ["member"], heuristics: ["boundary values"],
  safetyRules: ["Use test accounts only"], actionBudget: 12, timeBudgetMinutes: 20, stopConditions: ["A safety rule would be violated"],
} as const;

describe("exploration charters", () => {
  it("requires both bounded budgets and stop/safety constraints", () => {
    expect(assertExplorationCharter(charter)).toEqual(charter);
    expect(() => assertExplorationCharter({ ...charter, actionBudget: 0 })).toThrow(/action budget/i);
    expect(() => assertExplorationCharter({ ...charter, stopConditions: [] })).toThrow(/stop condition/i);
  });

  it("records unexpected non-authoritative behavior as a finding, not coverage", () => {
    expect(createExploratoryFinding({ charterId: charter.charterId, observation: "Recovery link loops", authority: "INFERRED" })).toMatchObject({
      kind: "EXPLORATORY_FINDING", satisfiesCoverage: false, candidate: true,
    });
  });
});
