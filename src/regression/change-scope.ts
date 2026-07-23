export type ChangeScope = Readonly<{ id: string; requirementIds: readonly string[]; codeSurfaces: readonly string[]; declaredDependencies: readonly string[]; gitPaths: readonly string[]; userScope: readonly string[] }>;
export type RegressionCase = Readonly<{ testCaseId: string; revisionId: string; requirementIds: readonly string[]; codeSurfaces: readonly string[]; declaredDependencies: readonly string[]; gitPaths: readonly string[]; userScope: readonly string[] }>;

import { sha256Text } from "../core/checksum.js";
import type { RunWorkspace, ArtifactRecord } from "../core/run-workspace.js";

/** Canonicalizes an explicit change input; selection never trusts an unchecksummed caller summary. */
export async function registerChangeScope(input: Readonly<{ workspace: RunWorkspace; changes: readonly ChangeScope[]; provenance: { kind: "git-diff" | "user-change" | "declared-change"; reference: string } }>): Promise<ArtifactRecord> {
  if (input.changes.length === 0) throw new Error("Change scope requires at least one declared change");
  const changes = [...input.changes].sort((left, right) => left.id.localeCompare(right.id)).map((change) => ({ ...change, requirementIds: [...change.requirementIds].sort(), codeSurfaces: [...change.codeSurfaces].sort(), declaredDependencies: [...change.declaredDependencies].sort(), gitPaths: [...change.gitPaths].sort(), userScope: [...change.userScope].sort() }));
  const inputChecksum = sha256Text(JSON.stringify({ changes, provenance: input.provenance }));
  return input.workspace.registerArtifactValue({ type: "change-scope", value: { artifactType: "change-scope", schemaVersion: "1.0.0", producerVersion: "0.1.0", changeScopeId: `CHANGE-${input.workspace.runId}`, runId: input.workspace.runId, changes, inputChecksum, provenance: input.provenance }, relationships: [], provenance: "runtime" });
}
