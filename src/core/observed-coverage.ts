import { creditsCoverage } from "./provenance.js";
import { array, isRecord } from "./values.js";

/**
 * The identity questions a filtered run asks of lane 2, in one place because two callers ask them and
 * must not disagree: `run-workflow.ts` computes the residual to drive, and `inspect-workspace-state.ts`
 * checks that every selected case was covered by SOME lane. Two independent readers of the same fact is
 * the drift shape this project keeps closing (see the two-readers comments in semantic-rules.ts).
 *
 * The minimum shape both callers already satisfy: a manifest record, an optional parsed value, and the
 * inspection's `valid` flag. `provenance` is REQUIRED rather than optional even though every field
 * around it is not, because it gates credit (see `observedCaseIdentities`) and both real callers carry
 * it — `ArtifactRecord.provenance` is a required `string`. An optional field would let a view that
 * omitted it silently fail the credit gate, which is the safe direction but a silent one; required makes
 * the omission a compile error instead.
 */
export type CoverageArtifactView = Readonly<{
  record: Readonly<{ id: string; type: string; sha256: string; provenance: string }>;
  value?: unknown;
  valid?: boolean;
}>;

/**
 * The two Execution Statuses that mean lane 2 ran the case and observed an outcome. An entry carrying
 * anything else names an identity NOTHING was learned about, and must neither suppress lane-1 driving
 * nor count towards a selection's coverage — otherwise a suite of `test.skip`ped specs, stamped
 * `runtime-observed` and passing every clause of `testResultBatchRule`, would leave a selected case
 * executed by neither lane in a run that finalizes valid.
 *
 * This is not a new line, it is the line this codebase already draws twice. `deriveRetestVerdict`
 * (src/retest/verdict.ts) maps exactly `BLOCKED`, `INCONCLUSIVE` and `NOT_RUN` to `CANNOT_VERIFY`, and
 * the JUnit projection (src/reporting/projections/junit.ts) calls `BLOCKED` and `INCONCLUSIVE` errors
 * "because neither is a verdict about the product — the attempt did not reach one", with `NOT_RUN`
 * skipped. Lane 2's own mapper agrees at the source (src/observed/report-mapping.ts): `skipped` becomes
 * `NOT_RUN` because "nothing executed", and `interrupted` becomes `BLOCKED` because "no outcome was ever
 * observed".
 *
 * `FAILED` DOES belong here, and that is the whole subtlety. A failed observation executed the case, so
 * re-driving it in lane 1 would be a second independent execution of something already observed — which
 * is exactly what the residual exists to prevent. It earns no coverage CREDIT: `evaluateCoverage`
 * (src/planning/coverage.ts) refuses every attempt whose status is not `PASSED`, so the obligation stays
 * unmet and the release gate still reports it. "Was it executed" and "did it satisfy the obligation" are
 * two different questions, and only the first one belongs in this module.
 *
 * An ALLOW-list, not a deny-list, so a status added to the contract later defaults to NOT covering and
 * the case gets driven. Under-crediting costs a redundant lane-1 execution; over-crediting loses one
 * entirely.
 */
const observedExecutedStatuses: readonly unknown[] = ["PASSED", "FAILED"];

/** `testCaseId:revisionId:instanceId`. The instance is part of the identity: one revision can have
 *  several parameterized instances (see RegressionCase in src/regression/change-scope.ts). */
export function caseIdentityKey(testCaseId: unknown, revisionId: unknown, instanceId: unknown): string | undefined {
  return typeof testCaseId === "string" && typeof revisionId === "string" && typeof instanceId === "string"
    ? `${testCaseId}:${revisionId}:${instanceId}`
    : undefined;
}

/**
 * Every canonical identity a Runtime-Observed Execution in this run actually executed. A batch entry
 * names its identity as `testCaseId`/`testCaseRevisionId`/`testCaseInstanceId` — the same triple
 * src/observed/report-mapping.ts binds an entry on, and the only case identity a batch carries (an entry
 * has no spec path; see src/reporting/projections/spec-locations.ts for where a path is read from).
 *
 * "Actually executed" is enforced, not merely asserted, by three filters — and each one is here because
 * without it an artifact that earns no coverage credit anywhere else would still stop lane 1 driving a
 * case AND satisfy the selection's union coverage, which is how a selected case reaches a finalized run
 * having been executed by neither lane:
 *
 *   - `valid === false` contributes nothing: a batch that failed its semantic rule observed nothing
 *     anybody can credit. Absent `valid` is treated as valid, which is what the writing side's artifact
 *     view means.
 *   - `creditsCoverage(record.provenance)` — the same shared predicate `deriveReleaseGateFromWorkspaceArtifacts`
 *     (src/reporting/release-gate.ts) applies to batches, for the same reason it gives: an agent-draft
 *     batch credits nothing. `RunWorkspace.registerArtifactValue` defaults an unstamped registration to
 *     `agent-draft`, so without this a producer that merely forgot the stamp would silently suppress
 *     driving. Two readers of one artifact must not disagree about whether it counts.
 *   - `observedExecutedStatuses` — see that constant. Per ENTRY, not per batch: one execution can
 *     legitimately run some tagged specs and skip others, and only the ones that ran are covered.
 */
export function observedCaseIdentities(artifacts: readonly CoverageArtifactView[]): ReadonlySet<string> {
  const identities = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.record.type !== "test-result-batch" || artifact.valid === false || !creditsCoverage(artifact.record.provenance) || !isRecord(artifact.value)) continue;
    for (const entry of array(artifact.value.entries)) {
      if (!isRecord(entry) || !observedExecutedStatuses.includes(entry.status)) continue;
      const key = caseIdentityKey(entry.testCaseId, entry.testCaseRevisionId, entry.testCaseInstanceId);
      if (key !== undefined) identities.add(key);
    }
  }
  return identities;
}

/** The registered `test-case` artifacts whose exact identity a batch entry observed. */
export function observedCoveredCaseIds(artifacts: readonly CoverageArtifactView[]): ReadonlySet<string> {
  const identities = observedCaseIdentities(artifacts);
  const covered = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.record.type !== "test-case" || artifact.valid === false || !isRecord(artifact.value)) continue;
    const key = caseIdentityKey(artifact.value.testCaseId, artifact.value.revisionId, artifact.value.instanceId);
    if (key !== undefined && identities.has(key)) covered.add(artifact.record.id);
  }
  return covered;
}
