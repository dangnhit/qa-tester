import { QaSkillsError } from "../core/errors.js";
import { executionStatuses, type ExecutionStatus } from "../contracts/types.js";

export type RetestVerdict = "FIXED" | "NOT_FIXED" | "PARTIALLY_FIXED" | "CANNOT_VERIFY" | "INTERMITTENT";
export type RegressionOutcome = "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
export type RetestResult = Readonly<{ bugId: string; verdict: RetestVerdict; reproductionStatuses: readonly ExecutionStatus[]; regressionOutcome?: RegressionOutcome }>;

function assertExecutionStatus(value: string): asserts value is ExecutionStatus {
  if (!(executionStatuses as readonly string[]).includes(value)) throw new QaSkillsError(`Unknown execution status: ${value}`, "ARTIFACT_BINDING");
}

export function deriveRegressionOutcome(statuses: readonly string[]): RegressionOutcome {
  for (const status of statuses) assertExecutionStatus(status);
  if (statuses.length === 0) return "NOT_RUN";
  if (statuses.includes("FAILED")) return "FAILED";
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.includes("INCONCLUSIVE")) return "INCONCLUSIVE";
  return statuses.every((status) => status === "PASSED") ? "PASSED" : "NOT_RUN";
}

/** Derives only the original bug conclusion; regression is deliberately a separate field. */
export function deriveRetestVerdict(input: Readonly<{ originalBugId: string; reproductionStatuses: readonly string[]; scenarioIds?: readonly string[]; regressionOutcome?: RegressionOutcome }>): RetestResult {
  if (!input.originalBugId) throw new QaSkillsError("Retest requires an original product bug ID", "ARTIFACT_BINDING");
  if (input.reproductionStatuses.length === 0) return { bugId: input.originalBugId, verdict: "CANNOT_VERIFY", reproductionStatuses: [], ...(input.regressionOutcome === undefined ? {} : { regressionOutcome: input.regressionOutcome }) };
  for (const status of input.reproductionStatuses) assertExecutionStatus(status);
  const statuses = new Set(input.reproductionStatuses);
  let verdict: RetestVerdict;
  if (statuses.has("BLOCKED") || statuses.has("INCONCLUSIVE") || statuses.has("NOT_RUN")) verdict = "CANNOT_VERIFY";
  else if (statuses.has("FAILED") && statuses.has("PASSED")) {
    const scenarioIds = input.scenarioIds;
    const distinctScenarios = scenarioIds === undefined ? 1 : new Set(scenarioIds).size;
    if (scenarioIds !== undefined && scenarioIds.length !== input.reproductionStatuses.length) throw new QaSkillsError("Retest scenario identities must align with reproduction statuses", "ARTIFACT_BINDING");
    verdict = distinctScenarios > 1 ? "PARTIALLY_FIXED" : "INTERMITTENT";
  }
  else if (statuses.has("FAILED")) verdict = "NOT_FIXED";
  else if (statuses.has("PASSED")) verdict = "FIXED";
  else verdict = "CANNOT_VERIFY";
  return { bugId: input.originalBugId, verdict, reproductionStatuses: [...input.reproductionStatuses] as ExecutionStatus[], ...(input.regressionOutcome === undefined ? {} : { regressionOutcome: input.regressionOutcome }) };
}
