import type { WorkflowResult } from "../operations/run-workflow.js";

export const ExitCode = {
  SUCCESS: 0,
  UNMET_OBLIGATIONS: 1,
  BLOCKED: 2,
  INVALID_INPUT: 3,
  SAFETY_DENIED: 4,
  ABORTED_OR_INTERNAL: 5,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Deterministic outcome/gate-to-exit-code mapping (first match wins):
 *   1. ABORTED                                -> ABORTED_OR_INTERNAL (5)
 *   2. BLOCKED                                -> BLOCKED (2)
 *   3. AWAITING_RUNTIME (nothing executed)    -> BLOCKED (2)
 *   4. AWAITING_HUMAN_INPUT (waiting on a person) -> BLOCKED (2)
 *   5. AWAITING_OBSERVED_EXECUTION (waiting on an observed suite) -> BLOCKED (2)
 *   6. validation.valid === false             -> UNMET_OBLIGATIONS (1)
 *   7. releaseRecommendation === NOT_READY    -> UNMET_OBLIGATIONS (1)
 *   8. COMPLETED_WITH_FAILURES                -> UNMET_OBLIGATIONS (1)
 *   9. otherwise                              -> SUCCESS (0)
 * READY_WITH_RISKS and "no gate" both fall through to SUCCESS: the gate itself
 * treats READY_WITH_RISKS as a go verdict, and a gate is registered only when the
 * generate-qa-report operation runs (full and regression modes); plan, execute,
 * exploratory, and retest modes register no gate.
 * All three non-terminal outcomes resolve ahead of `validation.valid`, and that ordering
 * is deliberate: a paused run legitimately has not registered the artifacts its
 * profile requires, so collapsing it into UNMET_OBLIGATIONS would report an unmet
 * obligation where the truth is "not finished yet".
 */
export function workflowExitCode(result: Pick<WorkflowResult, "outcome" | "validation" | "releaseRecommendation">): ExitCode {
  if (result.outcome === "ABORTED") return ExitCode.ABORTED_OR_INTERNAL;
  if (result.outcome === "BLOCKED") return ExitCode.BLOCKED;
  if (result.outcome === "AWAITING_RUNTIME") return ExitCode.BLOCKED;
  if (result.outcome === "AWAITING_HUMAN_INPUT") return ExitCode.BLOCKED;
  if (result.outcome === "AWAITING_OBSERVED_EXECUTION") return ExitCode.BLOCKED;
  if (!result.validation.valid) return ExitCode.UNMET_OBLIGATIONS;
  if (result.releaseRecommendation === "NOT_READY") return ExitCode.UNMET_OBLIGATIONS;
  if (result.outcome === "COMPLETED_WITH_FAILURES") return ExitCode.UNMET_OBLIGATIONS;
  return ExitCode.SUCCESS;
}
