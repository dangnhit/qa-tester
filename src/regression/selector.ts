import { indexByTestCaseIdentity, type TestCaseIdentity } from "../core/artifact-index.js";

import type { ChangeScope, RegressionCase } from "./change-scope.js";

export type RegressionSource = "requirement-mapping" | "code-surface-mapping" | "declared-dependency" | "git-diff-heuristic" | "user-scope";
export const regressionMappingSources = ["requirement-mapping", "code-surface-mapping", "declared-dependency", "git-diff-heuristic", "user-scope"] as const satisfies readonly RegressionSource[];
export type RegressionDecision = Readonly<{ testCaseId: string; revisionId: string; instanceId: string; source: RegressionSource; rationale: string; confidence: number }>;
export type UnmappedChangeRisk = Readonly<{ changeId: string; rationale: string; confidence: number }>;
export type RegressionSelection = Readonly<{ selected: readonly RegressionDecision[]; excluded: readonly RegressionDecision[]; unmappedChangeRisks: readonly UnmappedChangeRisk[]; complete: boolean }>;

const priorities: readonly Readonly<{ source: RegressionSource; change: keyof ChangeScope; test: keyof RegressionCase; confidence: number }>[] = [
  { source: "requirement-mapping", change: "requirementIds", test: "requirementIds", confidence: 1 },
  { source: "code-surface-mapping", change: "codeSurfaces", test: "codeSurfaces", confidence: 0.9 },
  { source: "declared-dependency", change: "declaredDependencies", test: "declaredDependencies", confidence: 0.8 },
  { source: "git-diff-heuristic", change: "gitPaths", test: "gitPaths", confidence: 0.6 },
  { source: "user-scope", change: "userScope", test: "userScope", confidence: 0.5 },
];

const sourcePriority = new Map(priorities.map((priority, index) => [priority.source, index]));

function intersects(left: readonly string[], right: readonly string[]): string | undefined { return left.find((item) => right.includes(item)); }

/** A case or a decision as the identity triple `indexByTestCaseIdentity` (src/core/artifact-index.ts)
 *  keys on. Both shapes spell the trailing components `revisionId`/`instanceId`, so the rename to that
 *  index's `testCaseRevisionId`/`testCaseInstanceId` lives here, once. */
function identityOf(entry: Readonly<{ testCaseId: string; revisionId: string; instanceId: string }>): TestCaseIdentity {
  return { testCaseId: entry.testCaseId, testCaseRevisionId: entry.revisionId, testCaseInstanceId: entry.instanceId };
}

/**
 * A TOTAL order over identities: the historical `:`-joined key first, then component by component.
 *
 * The joined key stays the primary term so that every non-colliding input keeps exactly the order it has
 * always had — the tie-break can only fire where two joined keys are EQUAL. That happens in one of two
 * ways, and nothing constrains the charset that separates them: `test-case.schema.json` gives
 * `testCaseId`, `revisionId` and `instanceId` each `{ "type": "string", "minLength": 1 }` with no
 * `pattern`, so `("TC:X", "R", "I")` and `("TC", "X:R", "I")` are two DISTINCT canonical cases that
 * rejoin to one string. Either they are the same identity (the comparison is 0, as before), or they are
 * a collision — and then the components decide, deterministically.
 *
 * Without this the two colliding cases compared equal, `Array.prototype.sort` left them in input order,
 * and the surviving decision was whichever one the CALLER happened to pass last. That order is not the
 * caller's to control: `buildCanonicalPlanImportBatch` (src/operations/run-workflow.ts) orders the
 * import by source artifact id, and those are ULIDs — equal to the millisecond, their relative order is
 * the random component, so the selection flipped between runs of the same fixture.
 */
function compareIdentity(
  left: Readonly<{ testCaseId: string; revisionId: string; instanceId: string }>,
  right: Readonly<{ testCaseId: string; revisionId: string; instanceId: string }>,
): number {
  return `${left.testCaseId}:${left.revisionId}:${left.instanceId}`.localeCompare(`${right.testCaseId}:${right.revisionId}:${right.instanceId}`)
    || left.testCaseId.localeCompare(right.testCaseId)
    || left.revisionId.localeCompare(right.revisionId)
    || left.instanceId.localeCompare(right.instanceId);
}

/**
 * Deterministic selection. A single canonical testcase can deliberately cover
 * several changes; the decision keeps its strongest source and every matched
 * change in a stable rationale rather than silently dropping coverage.
 *
 * "Deterministic" is a property of the input SET, not of the order it arrives in, and both halves of
 * that are load-bearing. The decision store is keyed STRUCTURALLY through the shared nested index rather
 * than by a `:`-joined string, for the reason `caseIdentity` (src/core/observed-coverage.ts) and
 * `artifact-index.ts`'s own docstring already give: a delimited join of the three identity components is
 * free to collide, and here a collision made two distinct canonical cases share ONE decision. The
 * consequences were both directions of wrong. The one that survived was decided by the caller's input
 * order — see `compareIdentity` — so a regression run's selection was not reproducible; and where only
 * one of a colliding pair matched a declared change, the other vanished from `selected` AND from
 * `excluded`, which is the one outcome this function must never produce, since a case in neither list is
 * a case nobody is accountable for executing.
 */
export function selectRegressionCases(input: Readonly<{ changes: readonly ChangeScope[]; testCases: readonly RegressionCase[] }>): RegressionSelection {
  const matched: RegressionDecision[] = [];
  const mappedChanges = new Set<string>();
  const changes = [...input.changes].sort((left, right) => left.id.localeCompare(right.id));
  const testCases = [...input.testCases].sort(compareIdentity);
  for (const testCase of testCases) {
    const matches = changes.flatMap((change) => priorities.map((priority) => ({ change, priority, match: intersects(change[priority.change] as readonly string[], testCase[priority.test] as readonly string[]) }))
      .filter((candidate): candidate is { change: ChangeScope; priority: (typeof priorities)[number]; match: string } => candidate.match !== undefined)
      .sort((left, right) => (sourcePriority.get(left.priority.source) ?? 0) - (sourcePriority.get(right.priority.source) ?? 0))[0] ?? []);
    if (matches.length === 0) continue;
    const strongest = [...matches].sort((left, right) => (sourcePriority.get(left.priority.source) ?? 0) - (sourcePriority.get(right.priority.source) ?? 0) || left.change.id.localeCompare(right.change.id))[0]!;
    matched.push({ testCaseId: testCase.testCaseId, revisionId: testCase.revisionId, instanceId: testCase.instanceId, source: strongest.priority.source, rationale: matches.sort((left, right) => left.change.id.localeCompare(right.change.id) || (sourcePriority.get(left.priority.source) ?? 0) - (sourcePriority.get(right.priority.source) ?? 0)).map((match) => `${match.priority.source} matched ${match.match} for ${match.change.id}`).join("; "), confidence: strongest.priority.confidence });
    for (const match of matches) mappedChanges.add(match.change.id);
  }
  // One decision per EXACT identity, last one wins — the `Map.set` semantics this replaced, minus the
  // join. A bucket holds every decision for one identity in source order, so the last of it is the
  // decision a repeated identity used to overwrite its way to.
  const decisionsByIdentity = indexByTestCaseIdentity(matched, identityOf);
  const selected = matched.filter((decision) => decisionsByIdentity.get(identityOf(decision)).at(-1) === decision);
  const excluded = testCases.filter((testCase) => decisionsByIdentity.get(identityOf(testCase)).length === 0).map((testCase) => ({ testCaseId: testCase.testCaseId, revisionId: testCase.revisionId, instanceId: testCase.instanceId, source: "user-scope" as const, rationale: "No declared change mapping selected this exact instance.", confidence: 1 }));
  const unmappedChangeRisks = changes.filter((change) => !mappedChanges.has(change.id)).map((change) => ({ changeId: change.id, rationale: "No registered testcase revision maps to this declared change scope.", confidence: 0 }));
  return { selected: [...selected].sort((left, right) => (sourcePriority.get(left.source) ?? 0) - (sourcePriority.get(right.source) ?? 0) || compareIdentity(left, right)), excluded, unmappedChangeRisks, complete: unmappedChangeRisks.length === 0 };
}
