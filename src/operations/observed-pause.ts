import { observedCaseIdentities } from "../core/observed-coverage.js";
import type { WorkflowOperationName } from "../core/modes.js";
import type { RunWorkspace } from "../core/run-workspace.js";

/** What a run paused for lane 2 tells its caller: the command that clears it, and why it stopped.
 *  `AWAITING_RUNTIME` returns a bare outcome because its remedy is a caller-side registry; this one, like
 *  `AWAITING_HUMAN_INPUT`, names a command a person is expected to run. */
export type PendingObservedExecution = Readonly<{
  operation: WorkflowOperationName;
  command: "execute playwright";
  reason: string;
}>;

/**
 * Stops in front of `execute-browser-test` while a filtered run still has no Runtime-Observed Execution.
 *
 * The condition is deliberately "no observed identity yet" rather than "no `test-result-batch` record":
 * a batch that failed its semantic rule observed nothing anybody can credit, so it must not clear the
 * pause — the same reason `observedCaseIdentities` (src/core/observed-coverage.ts) ignores it when
 * computing the residual. One fact, one reader.
 *
 * Self-clearing and idempotent: a resume with still no batch pauses again identically, which is what
 * stops a resume from silently falling back to driving the whole selection.
 */
export async function pendingObservedExecution(
  workspace: RunWorkspace,
  operation: WorkflowOperationName,
  expected: boolean,
): Promise<PendingObservedExecution | undefined> {
  if (!expected || operation !== "execute-browser-test") return undefined;
  if (observedCaseIdentities(await workspace.readRegisteredArtifacts()).size > 0) return undefined;
  return {
    operation,
    command: "execute playwright",
    reason: "The run expects a Runtime-Observed Execution: run `qa-skill execute playwright --root <root> --run-id <runId> --spec-dir <dir>`, then resume with resumeRunId.",
  };
}
