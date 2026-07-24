import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { ArtifactType } from "../contracts/types.js";
import { validateArtifact } from "../contracts/validator.js";
import {
  matchesEvidencePrimary,
  type ArtifactRecord,
  type Manifest,
  type WorkspaceDiagnostic,
  type WorkspaceMetadata,
} from "./artifact-record.js";
import { sha256, sha256Text } from "./checksum.js";
import { QaSkillsError } from "./errors.js";
import { assertPathWithin, assertRealpathWithin } from "./fs.js";
import { operationsForMode, type WorkflowOperationName } from "./modes.js";
import { semanticRules, type CrossRunView, type RelatedArtifact, type SemanticContext } from "./semantic-rules.js";
import { array, canonicalJson, isRecord } from "./values.js";

/**
 * Read/validate path extracted from `run-workspace.ts` (Task 16). `inspectWorkspaceState` reads a
 * persisted workspace, revalidates every registered artifact, and returns the soft-invalidation
 * diagnostics. It is behavior-identical to the pre-extraction free function; the ONLY change is that
 * cross-run access (`RunWorkspace.open`) is INJECTED as the `openRun` parameter, so this module imports
 * NOTHING from `run-workspace.ts` and the read-path ↔ `RunWorkspace.open` recursion is broken without a
 * static cycle. Shared types (`WorkspaceMetadata`, `WorkspaceDiagnostic`, `Manifest`, `ArtifactRecord`)
 * and the shared `matchesEvidencePrimary` helper live in the neutral `artifact-record.ts`.
 */

/** A manifest record paired with its revalidated payload (`value` absent for binary media artifacts and
 *  for artifacts that failed to bind) and its current validity in the read-path cascade. Inspect-only. */
export type LoadedArtifact = {
  record: ArtifactRecord;
  value?: Record<string, unknown>;
  valid: boolean;
};

const checkpointOutputTypes: Readonly<Record<WorkflowOperationName, readonly ArtifactType[]>> = {
  "ingest-requirement-analysis": ["requirement-analysis"],
  "ingest-testcases": ["test-case"],
  "ingest-coverage-obligation": ["coverage-obligation"],
  "prepare-test-data": ["test-data-manifest"],
  "execute-browser-test": ["test-result"],
  "collect-evidence": ["evidence", "evidence-gap", "exploratory-finding"],
  "generate-bug-report": ["bug-report", "incident"],
  "generate-qa-report": ["release-gate", "qa-execution-report"],
  "register-exploration-charter": ["exploration-charter"],
  "reproduce-bug": ["test-result"],
  "select-regression": ["regression-selection"],
  "derive-retest-verdict": ["retest-result"],
};

function checkpointStateChecksum(state: unknown): string { return sha256Text(canonicalJson(state)); }

function sameCheckpointRefs(left: readonly unknown[], right: readonly unknown[]): boolean {
  const normalize = (items: readonly unknown[]) => items.map((item) => isRecord(item) && typeof item.artifactId === "string" && typeof item.sha256 === "string" ? `${item.artifactId}:${item.sha256}` : "").sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

/** Checkpoint execution selection is an ordered worklist, unlike aggregate
 * fact sets such as evidence sources. */
function sameOrderedCheckpointRefs(left: readonly unknown[], right: readonly unknown[]): boolean {
  const normalize = (item: unknown) => isRecord(item) && typeof item.artifactId === "string" && typeof item.sha256 === "string" ? `${item.artifactId}:${item.sha256}` : "";
  return left.length === right.length && left.every((item, index) => normalize(item) === normalize(right[index]));
}

/** The selection record, rather than a checkpoint snapshot, owns execution
 * membership and order. Excluded decisions intentionally never appear here. */
function selectedExecutionCaseRefs(
  selection: LoadedArtifact | undefined,
  artifacts: readonly LoadedArtifact[],
): readonly { artifactId: string; sha256: string }[] | undefined {
  if (!selection?.value || selection.record.type !== "regression-selection" || !Array.isArray(selection.value.selected)) return undefined;
  const refs: { artifactId: string; sha256: string }[] = [];
  for (const decision of selection.value.selected) {
    if (!isRecord(decision) || typeof decision.testCaseId !== "string" || typeof decision.revisionId !== "string" || typeof decision.instanceId !== "string") return undefined;
    const matches = artifacts.filter((artifact) => artifact.valid && artifact.record.type === "test-case" && selection.record.relationships.includes(artifact.record.id)
      && artifact.value?.testCaseId === decision.testCaseId && artifact.value?.revisionId === decision.revisionId && artifact.value?.instanceId === decision.instanceId);
    if (matches.length !== 1) return undefined;
    refs.push({ artifactId: matches[0]!.record.id, sha256: matches[0]!.record.sha256 });
  }
  return refs;
}

/** A final evidence record is meaningful only when its one result relationship
 * proves the same immutable testcase revision and instance as its payload. */
function exactAttemptEvidenceBinding(
  artifact: LoadedArtifact,
  artifacts: readonly LoadedArtifact[],
): boolean {
  const value = artifact.value;
  if (!value || typeof value.attemptId !== "string") return false;
  const resultRelationships = artifact.record.relationships.filter((id) => artifacts.some((candidate) => candidate.valid && candidate.record.id === id && candidate.record.type === "test-result"));
  const results = artifacts.filter((candidate) => candidate.valid && candidate.record.type === "test-result" && candidate.value?.attemptId === value.attemptId);
  const result = results.length === 1 ? results[0] : undefined;
  if (!result || resultRelationships.length !== 1 || resultRelationships[0] !== result.record.id || value.runId !== result.value?.runId) return false;
  return value.testCaseId === result.value?.testCaseId
    && value.testCaseRevisionId === result.value?.testCaseRevisionId
    && value.testCaseInstanceId === result.value?.testCaseInstanceId;
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function addDiagnostic(
  diagnostics: WorkspaceDiagnostic[],
  diagnostic: WorkspaceDiagnostic,
): void {
  if (!diagnostics.some((candidate) =>
    candidate.code === diagnostic.code
    && candidate.relativePath === diagnostic.relativePath
    && candidate.message === diagnostic.message
  )) diagnostics.push(diagnostic);
}

function invalidate(
  artifact: LoadedArtifact,
  diagnostics: WorkspaceDiagnostic[],
  code: string,
  message: string,
): boolean {
  addDiagnostic(diagnostics, { code, message, relativePath: artifact.record.relativePath });
  if (!artifact.valid) return false;
  artifact.valid = false;
  return true;
}

/** Builds the READ-path `SemanticContext` for one persisted artifact. The related-artifact pool is
 *  the cascade-sensitive valid set (`validArtifacts`, recomputed each fixpoint pass), so an artifact
 *  invalidated earlier this pass drops out of any later rule's view — preserving the read-path
 *  cascade. `registeredRecord` is backed by the full manifest and is therefore stable regardless of
 *  validity. Cross-run access reopens via `dirname(dirname(path))`, matching the current read-path
 *  `RunWorkspace.open` call sites — supplied here by the injected `openRun` so this module never
 *  imports the `RunWorkspace` class. */
function buildReadContext(
  artifact: LoadedArtifact,
  value: Record<string, unknown>,
  validArtifacts: readonly LoadedArtifact[],
  manifest: Manifest,
  metadata: WorkspaceMetadata,
  path: string,
  expectedRunId: string,
  openRun: (root: string, runId: string) => Promise<CrossRunView>,
): SemanticContext {
  const root = dirname(dirname(path));
  const toRelated = (candidate: LoadedArtifact): RelatedArtifact =>
    candidate.value === undefined ? { record: candidate.record } : { record: candidate.record, value: candidate.value };
  return {
    stage: "read",
    type: artifact.record.type,
    value,
    self: artifact.record,
    relationships: artifact.record.relationships,
    runId: expectedRunId,
    path,
    root,
    linkedRunId: metadata.linkedRunId,
    environmentProfileId: metadata.environmentProfileId,
    mode: metadata.mode,
    relatedOfType: (type) => validArtifacts.filter((candidate) => candidate.record.type === type).map(toRelated),
    related: () => validArtifacts.map(toRelated),
    registeredRecord: (id, type) => manifest.artifacts.find((candidate) => candidate.id === id && (type === undefined || candidate.type === type)),
    openRun: (runId) => openRun(root, runId),
  };
}

async function filesUnder(root: string, directory: string): Promise<string[]> {
  await assertPathWithin(root, directory);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry);
    await assertPathWithin(root, path);
    if ((await stat(path)).isDirectory()) return filesUnder(root, path);
    return [path];
  }));
  return files.flat();
}

export async function inspectWorkspaceState(
  path: string,
  expectedRunId: string,
  openRun: (root: string, runId: string) => Promise<CrossRunView>,
): Promise<{
  metadata: WorkspaceMetadata;
  manifest: Manifest;
  artifacts: LoadedArtifact[];
  diagnostics: WorkspaceDiagnostic[];
}> {
  const metadataPath = await assertRealpathWithin(path, "run-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as WorkspaceMetadata;
  if (!validateArtifact("run-metadata", metadata).valid) {
    throw new QaSkillsError("Invalid workspace metadata or finalized profile/mode binding", "INVALID_ARTIFACT");
  }
  if (metadata.runId !== expectedRunId) {
    throw new QaSkillsError("Metadata run ID does not match the requested workspace", "ARTIFACT_BINDING");
  }

  const manifestPath = await assertRealpathWithin(path, "artifact-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  if (!validateArtifact("artifact-manifest", manifest).valid) {
    throw new QaSkillsError("Invalid artifact manifest", "INVALID_MANIFEST");
  }
  if (manifest.runId !== expectedRunId) {
    throw new QaSkillsError("Manifest run ID does not match the requested workspace", "ARTIFACT_BINDING");
  }

  const diagnostics: WorkspaceDiagnostic[] = [];
  const knownIds = new Set(manifest.artifacts.map((artifact) => artifact.id));
  const duplicateIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (seenIds.has(artifact.id)) duplicateIds.add(artifact.id);
    seenIds.add(artifact.id);
    for (const relationship of artifact.relationships) {
      if (!knownIds.has(relationship)) {
        addDiagnostic(diagnostics, {
          code: "UNKNOWN_RELATIONSHIP",
          message: `Relationship ${relationship} is not registered in this workspace`,
          relativePath: artifact.relativePath,
        });
      }
    }
  }

  const artifacts = await Promise.all(manifest.artifacts.map(async (record): Promise<LoadedArtifact> => {
    const loaded: LoadedArtifact = { record, valid: true };
    if (duplicateIds.has(record.id)) {
      invalidate(loaded, diagnostics, "DUPLICATE_ARTIFACT_ID", `Manifest artifact ID ${record.id} is ambiguous`);
    }
    let absolutePath: string;
    try {
      absolutePath = await assertRealpathWithin(path, record.relativePath);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") {
        invalidate(loaded, diagnostics, "MISSING_FILE", `Missing registered file ${record.relativePath}`);
        return loaded;
      }
      throw error;
    }
    if (await sha256(absolutePath) !== record.sha256) {
      invalidate(loaded, diagnostics, "CHECKSUM_MISMATCH", `Checksum mismatch for ${record.relativePath}`);
      return loaded;
    }
    if (record.mediaType !== undefined) return loaded;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
    } catch {
      invalidate(loaded, diagnostics, "ARTIFACT_TYPE_MISMATCH", `Registered ${record.type} payload is not valid JSON`);
      return loaded;
    }
    if (!isRecord(value) || !validateArtifact(record.type, value).valid) {
      invalidate(loaded, diagnostics, "ARTIFACT_TYPE_MISMATCH", `Payload does not match declared artifact type ${record.type}`);
      return loaded;
    }
    loaded.value = value;
    return loaded;
  }));

  for (const artifact of artifacts) {
    if (artifact.record.relationships.some((relationship) => !knownIds.has(relationship))) artifact.valid = false;
    const value = artifact.value;
    if (!value || !artifact.valid) continue;
    if (Object.hasOwn(value, "runId") && value.runId !== expectedRunId) {
      invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Artifact run ID does not match this workspace");
    }
    if (Object.hasOwn(value, "environmentProfileId") && value.environmentProfileId !== metadata.environmentProfileId) {
      invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Artifact environment profile ID does not match this workspace");
    }
  }

  const environmentArtifacts = artifacts.filter((artifact) => artifact.record.type === "environment-profile");
  if (environmentArtifacts.length !== 1) {
    throw new QaSkillsError("Workspace must have one authoritative environment profile", "ARTIFACT_BINDING");
  }
  const environmentArtifact = environmentArtifacts[0];
  if (environmentArtifact?.value?.environmentProfileId !== metadata.environmentProfileId) {
    invalidate(
      environmentArtifact as LoadedArtifact,
      diagnostics,
      "INVALID_REFERENCE",
      "Metadata environment profile ID does not match the authoritative registered environment profile",
    );
  }

  let changed = true;
  while (changed) {
    changed = false;
    const validArtifacts = artifacts.filter((artifact) => artifact.valid && artifact.value);
    const valuesOf = (type: ArtifactType): LoadedArtifact[] =>
      validArtifacts.filter((artifact) => artifact.record.type === type);
    for (const artifact of validArtifacts) {
      const value = artifact.value;
      if (!value) continue;
      const rule = semanticRules[artifact.record.type];
      if (!rule || !rule.appliesTo.read) continue;
      const violation = await rule.evaluate(buildReadContext(artifact, value, validArtifacts, manifest, metadata, path, expectedRunId, openRun));
      if (violation) {
        changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", violation.message) || changed;
      }
    }
    const attempts = new Map<unknown, LoadedArtifact[]>();
    for (const artifact of valuesOf("test-result")) {
      const attemptId = artifact.value?.attemptId;
      attempts.set(attemptId, [...(attempts.get(attemptId) ?? []), artifact]);
    }
    for (const duplicates of attempts.values()) {
      if (duplicates.length > 1) {
        for (const artifact of duplicates) {
          changed = invalidate(artifact, diagnostics, "AMBIGUOUS_ATTEMPT", `Attempt ${String(artifact.value?.attemptId)} has multiple definitions`) || changed;
        }
      }
    }
    // Evidence READ stays inline (NOT migrated onto the single-violation `semanticRules` table): block A
    // (attempt/testcase identity) and block B (derived-screenshot descriptor↔raw checksum) are two
    // INDEPENDENT `if`s, so a derived screenshot with BOTH tampered emits TWO diagnostics in one pass —
    // a distinction the return-first rule would collapse. Restored byte-for-byte from the pre-Task-15c
    // read branch; the write path lives in `evidenceRule`, and the per-path message drift is preserved.
    for (const artifact of validArtifacts) {
      const value = artifact.value as Record<string, unknown>;
      if (artifact.record.type === "evidence") {
        const matches = valuesOf("test-result").filter((candidate) => candidate.value?.attemptId === value.attemptId);
        const match = matches[0];
        if (matches.length !== 1 || match === undefined || artifact.record.relationships.filter((id) => id === match.record.id).length !== 1
          || value.testCaseId !== match.value?.testCaseId || value.testCaseRevisionId !== match.value?.testCaseRevisionId || value.testCaseInstanceId !== match.value?.testCaseInstanceId) {
          changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Evidence must reference one exact registered attempt and matching testcase identity") || changed;
        }
        const evidenceRelationships = artifact.record.relationships.filter((id) => artifacts.some((candidate) => candidate.record.id === id && candidate.record.type === "evidence" && candidate.value));
        const derivation = isRecord(value.derivation) ? value.derivation : undefined;
        if (evidenceRelationships.length > 0) {
          const sourceDescriptor = artifacts.find((candidate) => candidate.record.id === derivation?.sourceEvidenceArtifactId && candidate.record.type === "evidence" && candidate.value);
          const sourceBinary = artifacts.find((candidate) => candidate.record.id === derivation?.sourceBinaryArtifactId && candidate.record.type === "evidence" && !candidate.value);
          if (!derivation || !sourceDescriptor || !sourceBinary
            || derivation.sourceEvidenceSha256 !== sourceDescriptor.record.sha256
            || derivation.sourceRawSha256 !== sourceBinary.record.sha256
            || !artifact.record.relationships.includes(sourceDescriptor.record.id)
            || !artifact.record.relationships.includes(sourceBinary.record.id)) {
            changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Derived screenshot must preserve exact source descriptor and raw checksum relationships") || changed;
          }
        }
      }
    }
  }

  const checkpoints = artifacts.filter((artifact) => artifact.valid && artifact.record.type === "workflow-checkpoint" && artifact.value !== undefined)
    .sort((left, right) => Number(left.value?.revision) - Number(right.value?.revision));
  for (const [index, checkpoint] of checkpoints.entries()) {
    const value = checkpoint.value as Record<string, unknown>;
    const prior = checkpoints[index - 1];
    const completed: readonly unknown[] = array(value.completedOperations);
    const outputs = isRecord(value.operationOutputs) ? value.operationOutputs : undefined;
    const operationOrder = typeof value.mode === "string" ? (() => { try { return operationsForMode(value.mode as never); } catch { return undefined; } })() : undefined;
    const completedPrefix = operationOrder !== undefined && completed.length === index
      && JSON.stringify(completed) === JSON.stringify(operationOrder.slice(0, index));
    const outputReferences = outputs === undefined ? [] : Object.entries(outputs);
    const outputReferencesValid = outputs !== undefined && completedPrefix
      && JSON.stringify(Object.keys(outputs).sort()) === JSON.stringify([...completed].sort())
      && outputReferences.every(([operation, items]) => Array.isArray(items)
        && items.every((item) => isRecord(item) && typeof item.artifactId === "string" && typeof item.sha256 === "string" && artifacts.some((artifact) => artifact.record.id === item.artifactId && artifact.record.sha256 === item.sha256 && checkpointOutputTypes[operation as WorkflowOperationName]?.includes(artifact.record.type))));
    const state = isRecord(value.state) ? value.state : undefined;
    const stateReference = (item: unknown) => isRecord(item) && typeof item.artifactId === "string" && typeof item.sha256 === "string" && artifacts.some((artifact) => artifact.record.id === item.artifactId && artifact.record.sha256 === item.sha256);
    const stateItems = (key: string): readonly unknown[] => state === undefined ? [] : array(state[key]);
    const stateTypes = (key: string) => stateItems(key).map((item) => isRecord(item) ? artifacts.find((artifact) => artifact.record.id === item.artifactId && artifact.record.sha256 === item.sha256)?.record.type : undefined);
    const uniqueRefs = (items: readonly unknown[]) => new Set(items.map((item) => isRecord(item) ? item.artifactId : undefined)).size === items.length;
    const stateReferencesValid = state !== undefined && checkpointStateChecksum(state) === value.stateChecksum && ["importedArtifacts", "executionCases", "reproductionAttempts", "regressionAttempts", "exploratoryFindings"].every((key) => Array.isArray(state[key]) && state[key].every(stateReference) && uniqueRefs(state[key] as unknown[])) && stateTypes("importedArtifacts").every((type) => ["requirement-analysis", "test-plan", "test-case", "coverage-obligation"].includes(type ?? "")) && stateTypes("executionCases").every((type) => type === "test-case") && stateTypes("reproductionAttempts").every((type) => type === "test-result") && stateTypes("regressionAttempts").every((type) => type === "test-result") && stateTypes("exploratoryFindings").every((type) => type === "exploratory-finding") && (state.selection === undefined || stateReference(state.selection)) && (state.charter === undefined || stateReference(state.charter));
    const validInitial = index !== 0 || (value.revision === 1 && value.supersedesArtifactId === undefined && checkpoint.record.relationships.length === 0);
    const newOperation = index === 0 || typeof completed.at(-1) !== "string" ? undefined : completed.at(-1) as WorkflowOperationName;
    const newOutputs: readonly unknown[] = newOperation === undefined || outputs === undefined ? [] : array(outputs[newOperation]);
    const expectedRelationships = index === 0 ? [] : [prior?.record.id, ...(Array.isArray(newOutputs) ? newOutputs.map((item) => isRecord(item) ? item.artifactId : undefined) : [])].filter((id): id is string => typeof id === "string").sort();
    const validSuccessor = index === 0 || (value.revision === index + 1 && value.supersedesArtifactId === prior?.record.id && Array.isArray(prior?.value?.completedOperations) && JSON.stringify(completed.slice(0, -1)) === JSON.stringify(prior.value.completedOperations) && JSON.stringify([...checkpoint.record.relationships].sort()) === JSON.stringify(expectedRelationships));
    const executionResultRefs: readonly unknown[] = outputs === undefined ? [] : array(outputs["execute-browser-test"]);
    const executionCaseRefs = executionResultRefs.flatMap((reference) => !isRecord(reference) ? [] : artifacts.find((artifact) => artifact.record.id === reference.artifactId && artifact.record.sha256 === reference.sha256)?.record.relationships.map((id) => {
      const artifact = artifacts.find((candidate) => candidate.record.id === id && candidate.record.type === "test-case");
      return artifact === undefined ? undefined : { artifactId: artifact.record.id, sha256: artifact.record.sha256 };
    }).filter((item): item is { artifactId: string; sha256: string } => item !== undefined) ?? []);
    const selectionOutputRefs = outputs === undefined ? [] : array(outputs["select-regression"]);
    const selectionOutput = selectionOutputRefs.length === 1 && isRecord(selectionOutputRefs[0]) ? selectionOutputRefs[0] : undefined;
    const selectionArtifact = selectionOutput === undefined ? undefined : artifacts.find((artifact) => artifact.valid && artifact.record.type === "regression-selection" && artifact.record.id === selectionOutput.artifactId && artifact.record.sha256 === selectionOutput.sha256);
    const selectedExecutionRefs = selectedExecutionCaseRefs(selectionArtifact, artifacts);
    const selectionStateValid = !completed.includes("select-regression") || (state !== undefined && selectionArtifact !== undefined && selectedExecutionRefs !== undefined && state.selection !== undefined && sameCheckpointRefs([state.selection], selectionOutputRefs) && sameOrderedCheckpointRefs(array(state.executionCases), selectedExecutionRefs));
    const operationStateValid = state !== undefined
      && (!completed.includes("reproduce-bug") || sameCheckpointRefs(array(state.reproductionAttempts), outputs === undefined ? [] : array(outputs["reproduce-bug"])))
      && (!completed.includes("execute-browser-test") || value.mode === "retest" || sameCheckpointRefs(array(state.executionCases), executionCaseRefs))
      && selectionStateValid;
    if (value.runId !== expectedRunId || value.mode !== metadata.mode || value.inputChecksum === undefined || value.stateChecksum === undefined || new Set(completed).size !== completed.length || !outputReferencesValid || !stateReferencesValid || !operationStateValid || !validInitial || !validSuccessor) {
      changed = invalidate(checkpoint, diagnostics, "INVALID_REFERENCE", "Workflow checkpoints must form an immutable revision chain with verified operation outputs") || changed;
    }
  }

  for (const artifact of artifacts.filter((candidate) => candidate.valid && (candidate.record.type === "evidence" || candidate.record.type === "evidence-gap") && candidate.value !== undefined)) {
    const value = artifact.value as Record<string, unknown>;
    if (artifact.record.type === "evidence") {
      if (!exactAttemptEvidenceBinding(artifact, artifacts)) {
        changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Evidence must have one exact test-result relationship and matching testcase identity") || changed;
      }
    } else if (value.scope === "attempt") {
      if (!exactAttemptEvidenceBinding(artifact, artifacts)) {
        changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Attempt-scoped Evidence Gap must have one exact test-result relationship and matching testcase identity") || changed;
      }
    } else if (value.scope !== "operational" || value.attemptId !== undefined || value.testCaseId !== undefined || value.testCaseRevisionId !== undefined || value.testCaseInstanceId !== undefined || artifact.record.relationships.some((id) => artifacts.some((candidate) => candidate.record.id === id && candidate.record.type === "test-result"))) {
      changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Operational Evidence Gap must not impersonate an attempt-bound observation") || changed;
    }
  }

  const evidenceDescriptors = artifacts.filter((artifact) => artifact.valid && artifact.record.type === "evidence" && artifact.value !== undefined);
  const binaryRecords = artifacts.filter((artifact) => artifact.valid && artifact.record.type === "evidence" && artifact.record.mediaType !== undefined);
  for (const descriptor of evidenceDescriptors) {
    const ids = descriptor.value?.binaryArtifactIds;
    const details = descriptor.value?.binaryArtifacts;
    if (!Array.isArray(ids) || !Array.isArray(details) || ids.length !== details.length || new Set(ids).size !== ids.length) {
      invalidate(descriptor, diagnostics, "INVALID_REFERENCE", "Evidence descriptor binary references are invalid");
      continue;
    }
    for (const detail of details) {
      if (!isRecord(detail) || typeof detail.id !== "string" || typeof detail.relativePath !== "string" || typeof detail.sha256 !== "string" || typeof detail.mediaType !== "string" || !ids.includes(detail.id)) {
        invalidate(descriptor, diagnostics, "INVALID_REFERENCE", "Evidence descriptor binary metadata is invalid");
        continue;
      }
      const binary = binaryRecords.find((candidate) => candidate.record.id === detail.id);
      if (!binary || binary.record.relativePath !== detail.relativePath || binary.record.sha256 !== detail.sha256 || binary.record.mediaType !== detail.mediaType) invalidate(descriptor, diagnostics, "INVALID_REFERENCE", "Evidence descriptor does not match its registered binary");
    }
    const primary = binaryRecords.find((candidate) => candidate.record.id === ids[0]);
    if (!primary || !matchesEvidencePrimary(descriptor.value as Record<string, unknown>, primary.record)) {
      invalidate(descriptor, diagnostics, "INVALID_REFERENCE", "Evidence descriptor does not match its designated primary binary");
    }
  }
  for (const binary of binaryRecords) {
    const references = evidenceDescriptors.filter((descriptor) => Array.isArray(descriptor.value?.binaryArtifactIds) && descriptor.value?.binaryArtifactIds.includes(binary.record.id));
    if (references.length !== 1) invalidate(binary, diagnostics, "INVALID_REFERENCE", "Evidence binary must be referenced exactly once by a canonical evidence descriptor");
  }

  const registered = new Set(manifest.artifacts.map((artifact) => artifact.relativePath));
  for (const directory of [join(path, "inputs"), join(path, "evidence")]) {
    for (const absolutePath of await filesUnder(path, directory)) {
      const relativePath = relative(path, absolutePath);
      if (!registered.has(relativePath)) addDiagnostic(diagnostics, { code: "ORPHAN_FILE", message: `Unregistered file ${relativePath}`, relativePath });
    }
  }
  return { metadata, manifest, artifacts, diagnostics };
}
