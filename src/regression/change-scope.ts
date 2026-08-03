import { QaSkillsError } from "../core/errors.js";
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
  if (typeof value.testCaseId !== "string" || typeof value.revisionId !== "string" || typeof value.instanceId !== "string") throw new QaSkillsError("Canonical test case lacks exact regression instance identity", "INVALID_ARTIFACT");
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

/** The five mapping arrays a change declares. Named once because `isChangeScope` checks them and the
 *  canonicalizing sort in `registerChangeScope` spells the same five; the sort stays written out so the
 *  spread's key order — and therefore `inputChecksum` — cannot be changed by a refactor here. */
const changeMappingFields = ["requirementIds", "codeSurfaces", "declaredDependencies", "gitPaths", "userScope"] as const;

/**
 * Exactly the shape `registerChangeScope` READS, as a guard an untyped edge can apply before calling it.
 *
 * `src/cli/workflow.ts` reads a change scope out of a caller's JSON file, where the `ChangeScope` type says
 * nothing at all. Without this, a change missing any of the five arrays reached the sort spread below and
 * threw a raw `TypeError` — measured: `change.requirementIds is not iterable` — carrying no error code, so
 * it surfaced as `ABORTED_OR_INTERNAL` exit 5 from inside `select-regression`, while every other refusal a
 * scaffold makes is `INVALID_ARTIFACT` exit 3 before anything is written.
 *
 * Asserted at BOTH ends, so the producer and the CLI cannot disagree about what a well-formed change is.
 * Note the deliberate asymmetry with `strings` above, which COERCES a malformed mapping array to `[]` when
 * reading a canonical test case: a test case that declares no mapping simply maps nothing, whereas a CHANGE
 * is the input the entire selection is derived from, so a malformed one is refused rather than narrowed to
 * a selection that silently misses cases.
 */
export function isChangeScope(value: unknown): value is ChangeScope {
  return isRecord(value) && typeof value.id === "string"
    && changeMappingFields.every((field) => Array.isArray(value[field]) && (value[field] as readonly unknown[]).every((item) => typeof item === "string"));
}

/** Canonicalizes an explicit change input; selection never trusts an unchecksummed caller summary. */
export async function registerChangeScope(input: Readonly<{ workspace: ChangeScopeWorkspace; changes: readonly ChangeScope[]; provenance: { kind: "git-diff" | "user-change" | "declared-change"; reference: string } }>): Promise<ArtifactRecord> {
  if (input.changes.length === 0) throw new QaSkillsError("Change scope requires at least one declared change", "INVALID_ARTIFACT");
  if (!input.changes.every(isChangeScope)) throw new QaSkillsError(`Change scope change must declare a string id and ${changeMappingFields.join(", ")} as arrays of strings`, "INVALID_ARTIFACT");
  const changes = [...input.changes].sort((left, right) => left.id.localeCompare(right.id)).map((change) => ({ ...change, requirementIds: [...change.requirementIds].sort(), codeSurfaces: [...change.codeSurfaces].sort(), declaredDependencies: [...change.declaredDependencies].sort(), gitPaths: [...change.gitPaths].sort(), userScope: [...change.userScope].sort() }));
  const inputChecksum = sha256Text(JSON.stringify({ changes, provenance: input.provenance }));
  return input.workspace.registerArtifactValue({ type: "change-scope", value: { artifactType: "change-scope", schemaVersion: "1.0.0", producerVersion: "0.1.0", changeScopeId: `CHANGE-${input.workspace.runId}`, runId: input.workspace.runId, changes, inputChecksum, provenance: input.provenance }, relationships: [], provenance: "runtime" });
}
