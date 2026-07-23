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

/** Deterministic selection. A single canonical testcase can deliberately cover
 * several changes; the decision keeps its strongest source and every matched
 * change in a stable rationale rather than silently dropping coverage. */
export function selectRegressionCases(input: Readonly<{ changes: readonly ChangeScope[]; testCases: readonly RegressionCase[] }>): RegressionSelection {
  const selected = new Map<string, RegressionDecision>();
  const mappedChanges = new Set<string>();
  const changes = [...input.changes].sort((left, right) => left.id.localeCompare(right.id));
  const testCases = [...input.testCases].sort((left, right) => `${left.testCaseId}:${left.revisionId}:${left.instanceId}`.localeCompare(`${right.testCaseId}:${right.revisionId}:${right.instanceId}`));
  for (const testCase of testCases) {
    const matches = changes.flatMap((change) => priorities.map((priority) => ({ change, priority, match: intersects(change[priority.change] as readonly string[], testCase[priority.test] as readonly string[]) }))
      .filter((candidate): candidate is { change: ChangeScope; priority: (typeof priorities)[number]; match: string } => candidate.match !== undefined)
      .sort((left, right) => (sourcePriority.get(left.priority.source) ?? 0) - (sourcePriority.get(right.priority.source) ?? 0))[0] ?? []);
    if (matches.length === 0) continue;
    const key = `${testCase.testCaseId}:${testCase.revisionId}:${testCase.instanceId}`;
    const strongest = [...matches].sort((left, right) => (sourcePriority.get(left.priority.source) ?? 0) - (sourcePriority.get(right.priority.source) ?? 0) || left.change.id.localeCompare(right.change.id))[0]!;
    selected.set(key, { testCaseId: testCase.testCaseId, revisionId: testCase.revisionId, instanceId: testCase.instanceId, source: strongest.priority.source, rationale: matches.sort((left, right) => left.change.id.localeCompare(right.change.id) || (sourcePriority.get(left.priority.source) ?? 0) - (sourcePriority.get(right.priority.source) ?? 0)).map((match) => `${match.priority.source} matched ${match.match} for ${match.change.id}`).join("; "), confidence: strongest.priority.confidence });
    for (const match of matches) mappedChanges.add(match.change.id);
  }
  const excluded = testCases.filter((testCase) => !selected.has(`${testCase.testCaseId}:${testCase.revisionId}:${testCase.instanceId}`)).map((testCase) => ({ testCaseId: testCase.testCaseId, revisionId: testCase.revisionId, instanceId: testCase.instanceId, source: "user-scope" as const, rationale: "No declared change mapping selected this exact instance.", confidence: 1 }));
  const unmappedChangeRisks = changes.filter((change) => !mappedChanges.has(change.id)).map((change) => ({ changeId: change.id, rationale: "No registered testcase revision maps to this declared change scope.", confidence: 0 }));
  return { selected: [...selected.values()].sort((left, right) => (sourcePriority.get(left.source) ?? 0) - (sourcePriority.get(right.source) ?? 0) || `${left.testCaseId}:${left.revisionId}:${left.instanceId}`.localeCompare(`${right.testCaseId}:${right.revisionId}:${right.instanceId}`)), excluded, unmappedChangeRisks, complete: unmappedChangeRisks.length === 0 };
}
