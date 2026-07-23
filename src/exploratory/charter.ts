import { QaSkillsError } from "../core/errors.js";

export type ExplorationAction = Readonly<{ actionId: string; target: string; kind: "navigate"; sideEffect: "none" | "read" | "write"; safetyRuleId: string; stopCondition?: string }>;
export type ExplorationCharter = Readonly<{ charterId: string; mission: string; scope: readonly string[]; roles: readonly string[]; heuristics: readonly string[]; safetyRules: readonly string[]; actions: readonly ExplorationAction[]; actionBudget: number; timeBudgetMinutes: number; stopConditions: readonly string[] }>;
export type ExploratoryFinding = Readonly<{ kind: "EXPLORATORY_FINDING"; charterId: string; observation: string; authority: string; candidate: boolean; satisfiesCoverage: false }>;

function nonEmptyStrings(value: unknown): value is readonly string[] { return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0); }
function actions(value: unknown, safetyRules: readonly string[], stopConditions: readonly string[]): value is readonly ExplorationAction[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const action = item as Record<string, unknown>;
    return typeof action.actionId === "string" && action.actionId.length > 0 && typeof action.target === "string" && action.target.length > 0 && action.kind === "navigate"
      && (action.sideEffect === "none" || action.sideEffect === "read" || action.sideEffect === "write") && typeof action.safetyRuleId === "string" && safetyRules.includes(action.safetyRuleId)
      && (action.stopCondition === undefined || (typeof action.stopCondition === "string" && stopConditions.includes(action.stopCondition)));
  });
}

/** Validates the bounded contract before any exploratory action is allowed. */
export function assertExplorationCharter(value: unknown): ExplorationCharter {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new QaSkillsError("Exploration charter is required", "INVALID_ARTIFACT");
  const charter = value as Record<string, unknown>;
  if (typeof charter.charterId !== "string" || charter.charterId.length === 0 || typeof charter.mission !== "string" || charter.mission.trim().length === 0) throw new QaSkillsError("Exploration charter identity and mission are required", "INVALID_ARTIFACT");
  for (const [label, field] of [["scope", charter.scope], ["roles", charter.roles], ["heuristics", charter.heuristics], ["safety rules", charter.safetyRules], ["stop condition", charter.stopConditions]] as const) {
    if (!nonEmptyStrings(field)) throw new QaSkillsError(`Exploration charter requires ${label}`, "INVALID_ARTIFACT");
  }
  if (!Number.isInteger(charter.actionBudget) || (charter.actionBudget as number) < 1) throw new QaSkillsError("Exploration charter requires a positive action budget", "INVALID_ARTIFACT");
  if (!Number.isInteger(charter.timeBudgetMinutes) || (charter.timeBudgetMinutes as number) < 1) throw new QaSkillsError("Exploration charter requires a positive time budget", "INVALID_ARTIFACT");
  if (!actions(charter.actions, charter.safetyRules as readonly string[], charter.stopConditions as readonly string[])) throw new QaSkillsError("Exploration charter requires bounded actions authorized by safety and stop rules", "INVALID_ARTIFACT");
  if ((charter.actions as readonly unknown[]).length > (charter.actionBudget as number)) throw new QaSkillsError("Exploration charter action list exceeds its action budget", "INVALID_ARTIFACT");
  return charter as unknown as ExplorationCharter;
}

/** Exploration observes and proposes; it never credits authoritative coverage. */
export function createExploratoryFinding(input: Readonly<{ charterId: string; observation: string; authority: string }>): ExploratoryFinding {
  if (!input.charterId || !input.observation.trim()) throw new QaSkillsError("Exploratory finding requires its charter and observation", "INVALID_ARTIFACT");
  return { kind: "EXPLORATORY_FINDING", charterId: input.charterId, observation: input.observation, authority: input.authority, candidate: input.authority !== "AUTHORITATIVE", satisfiesCoverage: false };
}
