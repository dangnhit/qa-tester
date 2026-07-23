import { QaSkillsError } from "../core/errors.js";

export type RetestVerdict = "FIXED" | "NOT_FIXED" | "PARTIALLY_FIXED" | "CANNOT_VERIFY" | "INTERMITTENT";
export type RegressionOutcome = "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
export type RetestResult = Readonly<{ bugId: string; verdict: RetestVerdict; reproductionStatuses: readonly string[]; regressionOutcome?: RegressionOutcome }>;

/** Derives only the original bug conclusion; regression is deliberately a separate field. */
export function deriveRetestVerdict(input: Readonly<{ originalBugId: string; reproductionStatuses: readonly string[]; regressionOutcome?: RegressionOutcome }>): RetestResult {
  if (!input.originalBugId) throw new QaSkillsError("Retest requires an original product bug ID", "ARTIFACT_BINDING");
  if (input.reproductionStatuses.length === 0) return { bugId: input.originalBugId, verdict: "CANNOT_VERIFY", reproductionStatuses: [], ...(input.regressionOutcome === undefined ? {} : { regressionOutcome: input.regressionOutcome }) };
  const statuses = new Set(input.reproductionStatuses);
  let verdict: RetestVerdict;
  if (statuses.has("BLOCKED") || statuses.has("INCONCLUSIVE") || statuses.has("NOT_RUN")) verdict = "CANNOT_VERIFY";
  else if (statuses.has("FAILED") && statuses.has("PASSED")) verdict = "INTERMITTENT";
  else if (statuses.has("FAILED")) verdict = "NOT_FIXED";
  else if (statuses.has("PASSED")) verdict = "FIXED";
  else verdict = "CANNOT_VERIFY";
  return { bugId: input.originalBugId, verdict, reproductionStatuses: [...input.reproductionStatuses], ...(input.regressionOutcome === undefined ? {} : { regressionOutcome: input.regressionOutcome }) };
}
