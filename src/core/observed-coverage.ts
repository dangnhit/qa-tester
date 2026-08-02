import { indexByTestCaseIdentity, type TestCaseIdentity } from "./artifact-index.js";
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

/** The one Execution Status that means lane 2 ran the case AND the product did not do what was expected.
 *  Deliberately NOT `!== "PASSED"`, which is how lane 1's `hasExecutionFailures` reads a `test-result`: an
 *  attempt has a recorded outcome whatever its status, while `NOT_RUN`, `BLOCKED` and `INCONCLUSIVE` mean
 *  lane 2 observed nothing at all — and by `observedExecutedStatuses` above, a case in one of those states
 *  is DRIVEN by lane 1 instead, so calling it a failure would report failure for a run that then passed. */
const observedFailedStatuses: readonly unknown[] = ["FAILED"];

/**
 * The canonical identity triple a lane-2 entry or a `test-case` payload names, or `undefined` when any
 * component is not a string. The instance is part of the identity: one revision can have several
 * parameterized instances (see RegressionCase in src/regression/change-scope.ts).
 *
 * Returned STRUCTURALLY, and matched through `indexByTestCaseIdentity` (src/core/artifact-index.ts),
 * because a DELIMITED JOIN of these three fields WAS free to collide and a collision here CREDITS
 * EXECUTION. Nothing used to constrain their charset — `test-case.schema.json` gave `testCaseId`,
 * `revisionId` and `instanceId` each `{ "type": "string", "minLength": 1 }` with no `pattern`, so
 * `("TC:X", "R", "I")` and `("TC", "X:R", "I")` were two distinct canonical cases that a `:`-joined key
 * flattened into one; `test-case.schema.json` now forbids `:` in each, closing exactly that gap, but
 * `revisionId` is still never checked against `sha256Fingerprint`, and the identity-tag regex
 * (src/observed/report-mapping.ts) still forbids only `] [ / @` and whitespace, so a structural match
 * stays the defense rather than a join over whichever charset a field currently happens to admit. One
 * batch entry would then credit BOTH: the uncredited case is subtracted from the residual lane 1 would
 * drive AND counted towards the checkpoint's union coverage, which is precisely the "executed by neither
 * lane" state this module exists to make unreachable.
 *
 * The nested map is the mechanism every OTHER reader of this same triple already uses — `testResultBatchRule`
 * (src/core/semantic-rules.ts), `selectedExecutionCaseRefs` and `regressionSelectionRule`
 * (src/core/inspect-workspace-state.ts, src/core/semantic-rules.ts), and `reproduce-bug`
 * (src/operations/run-workflow.ts) — and `artifact-index.ts`'s own docstring already argues exactly this
 * point ("a `${a}|${b}|${c}` join would have been free to collide [...] The identity triple is a NESTED
 * map for the same reason"). Using it rather than restating the assumption is what "one reader" means
 * here, and it costs this module no dependency it should not have: `artifact-index` is the `src/core/`
 * leaf that imports nothing.
 *
 * The all-strings guard is NOT redundant under nested keys, and is the one thing the join gave for free.
 * `Map` compares with SameValueZero, so a `{}` batch entry and a `{}` unparsed `test-case` payload would
 * MATCH on three `undefined` components, where a joined key returned `undefined` and skipped both.
 */
export function caseIdentity(testCaseId: unknown, revisionId: unknown, instanceId: unknown): TestCaseIdentity | undefined {
  return typeof testCaseId === "string" && typeof revisionId === "string" && typeof instanceId === "string"
    ? { testCaseId, testCaseRevisionId: revisionId, testCaseInstanceId: instanceId }
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
 *
 * A LIST rather than a set, because a structural identity has no value equality a `Set` could dedup on
 * and `indexByTestCaseIdentity` buckets repeats anyway. Both callers outside this module ask only whether
 * it is EMPTY — `pendingObservedExecution` (src/operations/observed-pause.ts) and
 * `assertResultPostcondition` (src/operations/run-workflow.ts) — and emptiness is unchanged by duplicates.
 *
 * `statuses` is a parameter, not a second traversal, so that `observedFailureIdentities` asks its narrower
 * question through the SAME batch-level credit gate — type, `valid`, provenance — that this one applies.
 * A separate loop would be a third reader free to disagree about whether a batch counts, which is the
 * drift this whole module exists to prevent.
 */
export function observedCaseIdentities(artifacts: readonly CoverageArtifactView[], statuses: readonly unknown[] = observedExecutedStatuses): readonly TestCaseIdentity[] {
  const identities: TestCaseIdentity[] = [];
  for (const artifact of artifacts) {
    if (artifact.record.type !== "test-result-batch" || artifact.valid === false || !creditsCoverage(artifact.record.provenance) || !isRecord(artifact.value)) continue;
    for (const entry of array(artifact.value.entries)) {
      if (!isRecord(entry) || !statuses.includes(entry.status)) continue;
      const identity = caseIdentity(entry.testCaseId, entry.testCaseRevisionId, entry.testCaseInstanceId);
      if (identity !== undefined) identities.push(identity);
    }
  }
  return identities;
}

/**
 * Every canonical identity lane 2 observed FAILING. A run holding one of these must not report success.
 *
 * This exists because "did anything fail" had three readers that all filtered `artifact.record.type ===
 * "test-result"`, and Phase 8b made a lane-2-only `regression` run reachable: with the whole selection
 * observed, lane 1 drives nothing, so a FAILED entry produced a run that finalized `COMPLETED` with
 * `validation.valid` true — where the same case driven in lane 1 would have failed and exited 1.
 *
 * `FAILED` credits the IDENTITY (the case was executed) but never the OBLIGATION — `evaluateCoverage`
 * (src/planning/coverage.ts) refuses any attempt that is not `PASSED` — so the release gate already
 * reported the unmet obligation. What was missing was the run's own terminal status saying so.
 */
export function observedFailureIdentities(artifacts: readonly CoverageArtifactView[]): readonly TestCaseIdentity[] {
  return observedCaseIdentities(artifacts, observedFailedStatuses);
}

/** The registered `test-case` artifacts whose exact identity a batch entry observed. Matched component by
 *  component through the shared nested index, never by a joined string — see `caseIdentity`. */
export function observedCoveredCaseIds(artifacts: readonly CoverageArtifactView[]): ReadonlySet<string> {
  const observed = indexByTestCaseIdentity(observedCaseIdentities(artifacts), (identity) => identity);
  const covered = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.record.type !== "test-case" || artifact.valid === false || !isRecord(artifact.value)) continue;
    const identity = caseIdentity(artifact.value.testCaseId, artifact.value.revisionId, artifact.value.instanceId);
    if (identity !== undefined && observed.get(identity).length > 0) covered.add(artifact.record.id);
  }
  return covered;
}
