import { array, isRecord } from "./values.js";

/**
 * The identity questions a filtered run asks of lane 2, in one place because two callers ask them and
 * must not disagree: `run-workflow.ts` computes the residual to drive, and `inspect-workspace-state.ts`
 * checks that every selected case was covered by SOME lane. Two independent readers of the same fact is
 * the drift shape this project keeps closing (see the two-readers comments in semantic-rules.ts).
 *
 * The minimum shape both callers already satisfy: a manifest record, an optional parsed value, and the
 * inspection's `valid` flag.
 */
export type CoverageArtifactView = Readonly<{
  record: Readonly<{ id: string; type: string; sha256: string }>;
  value?: unknown;
  valid?: boolean;
}>;

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
 * `valid === false` contributes nothing, deliberately: a batch that failed its semantic rule must not be
 * able to suppress driving a case. Absent `valid` is treated as valid, which is what the writing side's
 * artifact view means.
 */
export function observedCaseIdentities(artifacts: readonly CoverageArtifactView[]): ReadonlySet<string> {
  const identities = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.record.type !== "test-result-batch" || artifact.valid === false || !isRecord(artifact.value)) continue;
    for (const entry of array(artifact.value.entries)) {
      if (!isRecord(entry)) continue;
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
