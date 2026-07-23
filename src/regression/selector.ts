import type { ChangeScope, RegressionCase } from "./change-scope.js";

export type RegressionSource = "requirement-mapping" | "code-surface-mapping" | "declared-dependency" | "git-diff-heuristic" | "user-scope";
export type RegressionDecision = Readonly<{ testCaseId: string; revisionId: string; source: RegressionSource; rationale: string; confidence: number }>;
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

/** Deterministic priority selection; all decisions retain a source, rationale, and confidence. */
export function selectRegressionCases(input: Readonly<{ changes: readonly ChangeScope[]; testCases: readonly RegressionCase[] }>): RegressionSelection {
  const selected = new Map<string, RegressionDecision>();
  const mappedChanges = new Set<string>();
  const changes = [...input.changes].sort((left, right) => left.id.localeCompare(right.id));
  const testCases = [...input.testCases].sort((left, right) => `${left.testCaseId}:${left.revisionId}`.localeCompare(`${right.testCaseId}:${right.revisionId}`));
  for (const testCase of testCases) for (const priority of priorities) {
    const match = changes.map((change) => ({ change, match: intersects(change[priority.change] as readonly string[], testCase[priority.test] as readonly string[]) })).find((candidate) => candidate.match !== undefined);
    if (!match || match.match === undefined) continue;
    const key = `${testCase.testCaseId}:${testCase.revisionId}`;
    selected.set(key, { testCaseId: testCase.testCaseId, revisionId: testCase.revisionId, source: priority.source, rationale: `${priority.source} matched ${match.match} for ${match.change.id}`, confidence: priority.confidence });
    mappedChanges.add(match.change.id); break;
  }
  const excluded = testCases.filter((testCase) => !selected.has(`${testCase.testCaseId}:${testCase.revisionId}`)).map((testCase) => ({ testCaseId: testCase.testCaseId, revisionId: testCase.revisionId, source: "user-scope" as const, rationale: "No declared change mapping selected this revision.", confidence: 1 }));
  const unmappedChangeRisks = changes.filter((change) => !mappedChanges.has(change.id)).map((change) => ({ changeId: change.id, rationale: "No registered testcase revision maps to this declared change scope.", confidence: 0 }));
  return { selected: [...selected.values()].sort((left, right) => (sourcePriority.get(left.source) ?? 0) - (sourcePriority.get(right.source) ?? 0) || `${left.testCaseId}:${left.revisionId}`.localeCompare(`${right.testCaseId}:${right.revisionId}`)), excluded, unmappedChangeRisks, complete: unmappedChangeRisks.length === 0 };
}
