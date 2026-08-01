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
 * The condition is deliberately "no CREDITED identity yet" rather than "no `test-result-batch` record",
 * and the dominant reason is that a batch can be registered and still have credited NOTHING: every entry
 * `NOT_RUN` because each tagged spec skipped, or every entry `BLOCKED` because the runner was interrupted,
 * or the batch stamped with a provenance that earns no credit anywhere. A run in that state is exactly
 * where it was before lane 2 ran, and it says so by pausing again rather than falling back to driving.
 *
 * `observedCaseIdentities`'s `valid === false` filter is NOT what does the work on this path, and naming it
 * as the reason would misdescribe the code: `readRegisteredArtifacts` throws on ANY diagnostic, so a batch
 * its own semantic rule invalidated makes the resume ERROR OUT before this predicate is reached at all.
 * That filter is live on the `inspectWorkspaceState` path instead. What the two paths share is the reader,
 * not the reason: one fact about what lane 2 credited, answered in one place
 * (src/core/observed-coverage.ts).
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
  if (observedCaseIdentities(await workspace.readRegisteredArtifacts()).length > 0) return undefined;
  return {
    operation,
    command: "execute playwright",
    reason: "The run expects a Runtime-Observed Execution: run `qa-skill execute playwright --root <root> --run-id <runId> --spec-dir <dir>`, then resume with resumeRunId.",
  };
}
