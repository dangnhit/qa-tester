import { isRecord } from "../core/values.js";

export type ChangeScope = Readonly<{ id: string; requirementIds: readonly string[]; codeSurfaces: readonly string[]; declaredDependencies: readonly string[]; gitPaths: readonly string[]; userScope: readonly string[] }>;
/** The instance is part of a canonical testcase identity: revisions can have
 * more than one parameterized/source instance. */
export type RegressionCase = Readonly<{ testCaseId: string; revisionId: string; instanceId: string; requirementIds: readonly string[]; codeSurfaces: readonly string[]; declaredDependencies: readonly string[]; gitPaths: readonly string[]; userScope: readonly string[] }>;

function strings(value: unknown): readonly string[] { return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []; }

/** Reads every regression mapping source from the canonical testcase revision. */
export function regressionCaseFromCanonical(value: Record<string, unknown>): RegressionCase {
  const index = isRecord(value.regressionIndex) ? value.regressionIndex : {};
  const coverage = isRecord(value.coverage) ? value.coverage : {};
  if (typeof value.testCaseId !== "string" || typeof value.revisionId !== "string" || typeof value.instanceId !== "string") throw new Error("Canonical test case lacks exact regression instance identity");
  return {
    testCaseId: value.testCaseId, revisionId: value.revisionId, instanceId: value.instanceId,
    requirementIds: index.requirementIds === undefined && typeof coverage.requirementId === "string" ? [coverage.requirementId] : strings(index.requirementIds),
    codeSurfaces: strings(index.codeSurfaces), declaredDependencies: strings(index.declaredDependencies), gitPaths: strings(index.gitPaths), userScope: strings(index.userScope),
  };
}

import { sha256Text } from "../core/checksum.js";
import type { ArtifactRecord } from "../core/artifact-record.js";
import type { ArtifactType } from "../contracts/types.js";

type ChangeScopeWorkspace = {
  readonly runId: string;
  registerArtifactValue(input: {
    type: ArtifactType;
    value: unknown;
    relationships: string[];
    provenance?: string;
  }): Promise<ArtifactRecord>;
};

/** Canonicalizes an explicit change input; selection never trusts an unchecksummed caller summary. */
export async function registerChangeScope(input: Readonly<{ workspace: ChangeScopeWorkspace; changes: readonly ChangeScope[]; provenance: { kind: "git-diff" | "user-change" | "declared-change"; reference: string } }>): Promise<ArtifactRecord> {
  if (input.changes.length === 0) throw new Error("Change scope requires at least one declared change");
  const changes = [...input.changes].sort((left, right) => left.id.localeCompare(right.id)).map((change) => ({ ...change, requirementIds: [...change.requirementIds].sort(), codeSurfaces: [...change.codeSurfaces].sort(), declaredDependencies: [...change.declaredDependencies].sort(), gitPaths: [...change.gitPaths].sort(), userScope: [...change.userScope].sort() }));
  const inputChecksum = sha256Text(JSON.stringify({ changes, provenance: input.provenance }));
  return input.workspace.registerArtifactValue({ type: "change-scope", value: { artifactType: "change-scope", schemaVersion: "1.0.0", producerVersion: "0.1.0", changeScopeId: `CHANGE-${input.workspace.runId}`, runId: input.workspace.runId, changes, inputChecksum, provenance: input.provenance }, relationships: [], provenance: "runtime" });
}
