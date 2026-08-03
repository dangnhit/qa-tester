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
 * and `indexByTestCaseIdentity` buckets repeats anyway. Every caller asks only whether it is EMPTY, or
 * filters it — `pendingObservedExecution` (src/operations/observed-pause.ts), `observedFailureIdentities`
 * below, `observedCoveredCaseIds` below, and `observedSelectedCaseIdentities` below — and emptiness is
 * unchanged by duplicates.
 *
 * "IN THIS RUN" IS NOT A NARROWING THIS FUNCTION HAS TO APPLY, and every caller depends on knowing that.
 * `runId` is required by test-result-batch.schema.json; `assertArtifactBinding` (src/core/run-workspace.ts)
 * refuses to register any value whose `runId` is not the workspace's; and `inspectWorkspaceState`
 * (src/core/inspect-workspace-state.ts) invalidates one that differs, which the `valid === false` filter
 * above then drops. So every batch this reader can see is this run's OWN, and "anywhere in this workspace"
 * and "in this run" name the same set of batches. What a scope can still narrow is which ENTRIES of them
 * count — nothing filters the observed suite by the selection, so one batch routinely carries entries for
 * selected and unselected cases alike.
 *
 * Two questions are therefore asked of this function directly and correctly: `pendingObservedExecution`
 * asks whether the operator has run the observed suite for this run at all, and `observedFailureIdentities`
 * below asks whether any entry reported a failure. Neither is a question about a selection. Only a caller
 * asking "is THIS run's SELECTION covered" wants `observedSelectedCaseIdentities` below.
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
 * Every identity a Runtime-Observed Execution executed THAT THIS RUN'S SELECTION NAMES.
 *
 * ONE caller wants this narrower question (Phase 9 item 3.3): `assertResultPostcondition`
 * (src/operations/run-workflow.ts) allows an EMPTY execution output when something was observed, and its
 * own comment says "a filtered run whose WHOLE SELECTION was covered". It used to ask
 * `observedCaseIdentities` instead, so a single entry for a case the selection EXCLUDED stood in for the
 * whole selection, and an execution operation could return zero results without throwing while the
 * selection was covered by nothing at all.
 *
 * The entry that makes the difference is an ordinary one, not a stray: a batch is always this run's own
 * (see `observedCaseIdentities` above), and nothing filters the observed suite by the selection, so one
 * batch normally names selected and unselected cases together.
 *
 * THE FAILURE QUESTION IS DELIBERATELY NOT SCOPED THIS WAY — `observedFailureIdentities` below — and the
 * two must not be merged again. An out-of-selection entry covers nothing this run asked for, so it may
 * not excuse an empty drive list; but the same entry reporting FAILED is a defect this run's own suite
 * observed, and dropping it left a run reporting success while holding a failure.
 *
 * A FILTER over `observedCaseIdentities`, not a second traversal, exactly as the failure question below
 * is a `statuses` argument to it rather than its own loop: the batch-level credit gate (type, `valid`,
 * provenance) and the per-entry status gate are asked ONCE, in one place, and this function only narrows
 * the answer. A separate loop here would be the third reader free to disagree about whether a batch
 * counts, which is the drift this module exists to prevent.
 *
 * `selection` is `TestCaseIdentity`, the STRUCTURAL triple — deliberately not the artifact ids
 * `observedCoveredCaseIds` returns, which live in a different key space entirely. Matched through the
 * shared nested index for the reason `caseIdentity` gives: a delimited join of the three components was
 * free to collide, and a collision here would put an UNSELECTED case in scope.
 */
export function observedSelectedCaseIdentities(
  artifacts: readonly CoverageArtifactView[],
  selection: readonly TestCaseIdentity[],
  statuses: readonly unknown[] = observedExecutedStatuses,
): readonly TestCaseIdentity[] {
  const selected = indexByTestCaseIdentity(selection, (identity) => identity);
  return observedCaseIdentities(artifacts, statuses).filter((identity) => selected.get(identity).length > 0);
}

/**
 * Every canonical identity lane 2 observed FAILING, over every batch this run registered. A run holding
 * one of these must not report success.
 *
 * This exists because "did anything fail" had three readers that all filtered `artifact.record.type ===
 * "test-result"`, and Phase 8b made a lane-2-only `regression` run reachable: with the whole selection
 * observed, lane 1 drives nothing, so a FAILED entry produced a run that finalized `COMPLETED` with
 * `validation.valid` true — where the same case driven in lane 1 would have failed and exited 1.
 *
 * DELIBERATELY UNSCOPED, and a selection-scoped version of this exact question reopened exactly that
 * defect once already. Unscoped IS "this run's batches" (see `observedCaseIdentities` above), so the only
 * thing intersecting against the selection removed was an entry of this run's own suite: a `FAILED /
 * PRODUCT_DEFECT` on a case the change scope did not map, in a run where NOTHING ELSE reports it. A
 * `regression` run imports no coverage obligations of its own, so `REQUIRED_COVERAGE_COMPLETE` cannot
 * catch it; `generate-bug-report` is lane-1-only, so no `bug-report` exists; and with the residual empty
 * lane 1 registers no `test-result`. The run finalized `COMPLETED` and exited 0 with nothing an operator
 * reads saying a test failed — measured, and pinned in
 * tests/operations/selection-scoped-observation.test.ts.
 *
 * So the asymmetry with `observedSelectedCaseIdentities` above is the point, not an oversight. Naming one
 * identity the run did not select is a loud, checkable over-report; losing the only signal a failure has
 * is not recoverable by the operator at all.
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
