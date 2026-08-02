import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArtifactType } from "../contracts/types.js";
import { validateArtifact } from "../contracts/validator.js";
import { indexByAttemptId, indexByTestCaseIdentity, type ArtifactIndex } from "./artifact-index.js";
import {
  evidenceSubject,
  matchesEvidencePrimary,
  type ArtifactRecord,
  type Manifest,
  type WorkspaceDiagnostic,
  type WorkspaceMetadata,
} from "./artifact-record.js";
import { sha256, sha256Text } from "./checksum.js";
import { QaSkillsError } from "./errors.js";
import { assertPathWithin, assertRealpathWithin, manifestRelativePath } from "./fs.js";
import { operationsForMode, type WorkflowOperationName } from "./modes.js";
import { observedCoveredCaseIds } from "./observed-coverage.js";
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
  // The removed per-decision scan tested a decision-INDEPENDENT prefix (valid + test-case + declared by
  // this selection) and then the identity triple. The prefix is hoisted into the indexed pool — it is a
  // membership test and stays a linear filter, run once — and only the triple is indexed. Nothing in the
  // loop below mutates `artifact.valid` or `artifacts`, so the pool is invariant for the whole call, and
  // building the index per call keeps it as fresh as the `.filter()` it replaces on every fixpoint pass.
  const declaredCasesByIdentity = indexByTestCaseIdentity(
    artifacts.filter((artifact) => artifact.valid && artifact.record.type === "test-case" && selection.record.relationships.includes(artifact.record.id)),
    (artifact) => ({ testCaseId: artifact.value?.testCaseId, testCaseRevisionId: artifact.value?.revisionId, testCaseInstanceId: artifact.value?.instanceId }),
  );
  const refs: { artifactId: string; sha256: string }[] = [];
  for (const decision of selection.value.selected) {
    if (!isRecord(decision) || typeof decision.testCaseId !== "string" || typeof decision.revisionId !== "string" || typeof decision.instanceId !== "string") return undefined;
    const matches = declaredCasesByIdentity.get({ testCaseId: decision.testCaseId, testCaseRevisionId: decision.revisionId, testCaseInstanceId: decision.instanceId });
    if (matches.length !== 1) return undefined;
    refs.push({ artifactId: matches[0]!.record.id, sha256: matches[0]!.record.sha256 });
  }
  return refs;
}

/** The attempt identity an artifact claims. Evidence carries it inside its `subject` union (schema
 *  2.0.0); an attempt-scoped Evidence Gap still carries it as flat sibling fields. `undefined` means the
 *  artifact claims no attempt — either an `observed-execution` evidence subject, which binds a
 *  `test-result-batch` execution rather than an attempt, or a malformed claim. */
type ClaimedAttemptIdentity = { attemptId: string; testCaseId: unknown; testCaseRevisionId: unknown; testCaseInstanceId: unknown };

function claimedAttemptIdentity(artifact: LoadedArtifact): ClaimedAttemptIdentity | undefined {
  if (artifact.record.type === "evidence") {
    const subject = evidenceSubject(artifact.value);
    return subject?.kind === "attempt" ? subject : undefined;
  }
  const value = artifact.value;
  return value && typeof value.attemptId === "string"
    ? { attemptId: value.attemptId, testCaseId: value.testCaseId, testCaseRevisionId: value.testCaseRevisionId, testCaseInstanceId: value.testCaseInstanceId }
    : undefined;
}

/** A final attempt-bound record is meaningful only when its one result relationship
 * proves the same immutable testcase revision and instance as its claimed identity.
 * `validResultsByAttempt` indexes exactly the pool the removed `.filter()` scanned — the artifacts
 * that are `valid` AND of type `test-result` — so `.get()` returns the same matches in the same order
 * and the `results.length === 1` ambiguity decision below is unchanged. */
function exactAttemptEvidenceBinding(
  identity: ClaimedAttemptIdentity | undefined,
  artifact: LoadedArtifact,
  artifacts: readonly LoadedArtifact[],
  validResultsByAttempt: ArtifactIndex<LoadedArtifact>,
): boolean {
  const value = artifact.value;
  if (!value || identity === undefined) return false;
  const resultRelationships = artifact.record.relationships.filter((id) => artifacts.some((candidate) => candidate.valid && candidate.record.id === id && candidate.record.type === "test-result"));
  const results = validResultsByAttempt.get(identity.attemptId);
  const result = results.length === 1 ? results[0] : undefined;
  if (!result || resultRelationships.length !== 1 || resultRelationships[0] !== result.record.id || value.runId !== result.value?.runId) return false;
  return identity.testCaseId === result.value?.testCaseId
    && identity.testCaseRevisionId === result.value?.testCaseRevisionId
    && identity.testCaseInstanceId === result.value?.testCaseInstanceId;
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
 *  invalidated earlier in this pass stays visible to this pass's later rules and drops out of view
 *  only on the NEXT pass — the pool shrinks between passes, not within one — still preserving the
 *  read-path cascade once the fixpoint converges. `registeredRecord` is backed by the full manifest
 *  and is therefore stable regardless of validity. Cross-run access reopens via
 *  `dirname(dirname(path))`, matching the current read-path `RunWorkspace.open` call sites — supplied
 *  here by the injected `openRun` so this module never imports the `RunWorkspace` class. */
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

/** Concurrency ceiling for the per-artifact revalidation fan-out below: a workspace's evidence set can
 *  include many large binaries (screenshots, traces), and hashing them all at once on every
 *  `RunWorkspace.open()` / `readRegisteredArtifacts()` call is an unbounded I/O burst. 16 mirrors the
 *  cap used by the workflow's own fan-out. */
const INSPECTION_FANOUT_CONCURRENCY = 16;

/** Bounded-concurrency counterpart to `Promise.all(items.map(mapper))`: runs at most `limit` mapper
 *  invocations at a time via a shared-cursor worker pool, while preserving both the result order (each
 *  result is written to its origin index, not push order) and full coverage (every item is visited
 *  exactly once). Output is therefore identical to the unbounded map it replaces — same results, same
 *  positions, same propagated rejection — just without opening every file at once. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const iterator = items.entries();
  const worker = async (): Promise<void> => {
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      const [index, item] = next.value;
      results[index] = await mapper(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
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

  const artifacts = await mapWithConcurrency(manifest.artifacts, INSPECTION_FANOUT_CONCURRENCY, async (record): Promise<LoadedArtifact> => {
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
    // INVESTIGATED (Task 26/D14) and deliberately NOT hoisted: this is the ONLY place in the read path
    // that recomputes a hash from actual file BYTES on disk and compares it to the manifest's declared
    // `record.sha256` — including for binaries (`record.mediaType !== undefined`). The evidence
    // descriptor <-> binary rule below (the `evidenceDescriptors`/`binaryRecords` loop) does NOT
    // re-derive a checksum from disk for binaries; it only cross-checks two already-DECLARED values
    // (`binary.record.sha256` from this manifest vs. `detail.sha256` from the descriptor JSON) for
    // internal consistency. A binary whose file bytes are tampered in place, with `record.sha256` and
    // the descriptor's declared checksum left untouched (both still reflect the pre-tamper hash), would
    // pass that rule and every other read-path check. So skipping this call for binaries (the literal
    // "hoist mediaType above sha256") would let such a tampered binary load as valid — an integrity
    // regression. Keep the hash here for every record, binary or not; Part 1's bounded fan-out is the
    // safe perf win instead.
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
  });

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
    // Built INSIDE the fixpoint, from THIS pass's `validArtifacts` snapshot: the valid pool shrinks
    // between passes, so an index hoisted above `while (changed)` would serve a stale, too-large pool
    // and let a rule keep binding to an artifact that was already invalidated. Within a pass it is
    // stable — `valuesOf` filters `validArtifacts` by TYPE only and never rereads `.valid`, so an
    // artifact invalidated earlier in this pass is still in the pool until the pass restarts. That is
    // why this one build can serve both the AMBIGUOUS_ATTEMPT loop and the evidence block below,
    // exactly as the repeated `valuesOf("test-result")` calls they replace did.
    const validResults = valuesOf("test-result");
    const attempts = indexByAttemptId(validResults, (artifact) => artifact.value?.attemptId);
    for (const duplicates of attempts.groups()) {
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
        const subject = evidenceSubject(value);
        if (subject?.kind === "observed-execution") {
          // Observed-execution evidence binds an execution, not an attempt, so block A's attempt check is
          // replaced (not skipped) by the positive assertion that it claims no test result at all.
          if (artifact.record.relationships.some((id) => validResults.some((candidate) => candidate.record.id === id))) {
            changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Observed-execution evidence must not reference a registered attempt") || changed;
          }
        } else {
          const matches = subject === undefined ? [] : attempts.get(subject.attemptId);
          const match = matches[0];
          if (matches.length !== 1 || match === undefined || artifact.record.relationships.filter((id) => id === match.record.id).length !== 1
            || subject?.testCaseId !== match.value?.testCaseId || subject?.testCaseRevisionId !== match.value?.testCaseRevisionId || subject?.testCaseInstanceId !== match.value?.testCaseInstanceId) {
            changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Evidence must reference one exact registered attempt and matching testcase identity") || changed;
          }
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
  // Hoisted out of the loop below, which — unlike the fixpoint above — cannot change what it reads: every
  // `invalidate` in it targets its own `workflow-checkpoint`, never a `test-case` or `test-result-batch`,
  // so the observed set is invariant for the whole loop. Read AFTER the fixpoint has settled on purpose:
  // a batch its own rule invalidated is already `valid === false` here and therefore covers nothing, which
  // is what stops a rejected observation from suppressing the requirement to have driven a case.
  const observedCaseIds = observedCoveredCaseIds(artifacts);
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
    const drivenCaseRefs = executionResultRefs.flatMap((reference) => !isRecord(reference) ? [] : artifacts.find((artifact) => artifact.record.id === reference.artifactId && artifact.record.sha256 === reference.sha256)?.record.relationships.map((id) => {
      const artifact = artifacts.find((candidate) => candidate.record.id === id && candidate.record.type === "test-case");
      return artifact === undefined ? undefined : { artifactId: artifact.record.id, sha256: artifact.record.sha256 };
    }).filter((item): item is { artifactId: string; sha256: string } => item !== undefined) ?? []);
    // Deduped by `artifactId` before it reaches the `sameCheckpointRefs` comparison below. `run-workflow.ts`'s
    // `occurrence` logic registers one `test-result` per occurrence, and its retest reproduction path
    // deliberately keeps duplicate source occurrences ("each one is a real reproduction attempt") —
    // uniqueness there is enforced per `attemptId`, not per test-case artifact id — so ONE selected case
    // driven by TWO `test-result`s is a legitimate retry, not corruption, and `drivenCaseRefs` above can
    // repeat that case's ref once per `test-result` that named it.
    //
    // Measured, not assumed: retest is the only mode whose own execution can put such a duplicate into
    // `drivenCaseRefs` today (`selectRegressionCases`, src/regression/selector.ts, already dedupes to one
    // decision per identity, and every other mode's input array comes from a registered-artifact scan that
    // never repeats an id) — and retest is also the one mode the comparison below never reaches: its own
    // `value.mode === "retest"` clause bypasses the whole thing unconditionally. So this dedup changes no
    // observable outcome for any run reachable today. It is defense-in-depth for `regression`/`execute`/
    // `full`, the modes the comparison DOES run for, and it is what stops a future narrowing of that retest
    // bypass from reintroducing the exact multiplicity failure this comparison already had once, for the
    // cross-lane (driven-and-observed) variant of the same union: an undeduped right side would make a
    // healthy run's length diverge from its duplicate-free left side (`state.executionCases`, kept
    // duplicate-free by `uniqueRefs` above as part of `stateReferencesValid`) and fail the sort-then-compare
    // MULTISET equality `sameCheckpointRefs` performs — reading the checkpoint as broken, permanently: no
    // open, resume, attestation, finalize, validation or export could read the run again, and there is no
    // abort command.
    //
    // The one behavioural change this DOES make today: a checkpoint whose own `execute-browser-test` output
    // lists the same `test-result` ref twice — a tamper, not anything a live run produces — now validates
    // where it previously would not have. That incidental tamper detection was a side effect of multiset
    // equality, not a property this clause was ever written to assert; it is about coverage (was every
    // selected case named by a lane), never about how many times a lane named it.
    const seenDrivenCaseIds = new Set<string>();
    const executionCaseRefs: { artifactId: string; sha256: string }[] = [];
    for (const reference of drivenCaseRefs) {
      if (seenDrivenCaseIds.has(reference.artifactId)) continue;
      seenDrivenCaseIds.add(reference.artifactId);
      executionCaseRefs.push(reference);
    }
    // Union coverage, not equality: a filtered `regression` run drives only the cases lane 2 did not
    // observe, so the selection is satisfied by a driven `test-result` OR a `test-result-batch` entry
    // carrying the same identity. Observed cases are intersected with the checkpoint's own selection
    // first, so a lane-2 suite that ran EXTRA tagged specs cannot widen what this checkpoint claims.
    //
    // What this ENFORCES, rather than assumes: every selected case is named by at least one lane. It does
    // NOT assume the two lanes are disjoint. Disjointness holds only when a batch is registered BEFORE
    // `execute-browser-test` computes its residual, and nothing forces that order — `qa-skill execute
    // playwright` opens any non-terminal run and never asks what has already been driven. So the observed
    // side contributes only the selected cases lane 1 did not drive, and the comparison below is a SET
    // comparison. Without that dedup a case named by BOTH lanes made the right side of
    // `sameCheckpointRefs` longer than the duplicate-free left side (`uniqueRefs`, above) and the
    // checkpoint invalid FOREVER: no `open`, resume, attestation, finalize, validation or export could
    // read the run again, and there is no abort command — all from a command that exits 0.
    //
    // Tolerating the overlap adds no slack. `executionCaseRefs` names what this checkpoint's own
    // `execute-browser-test` output drove, and the observed side is intersected with
    // `state.executionCases` on the line below, so each side is independently a SUBSET of the selection.
    // Set equality therefore reduces to exactly "every selected case was driven or observed", which is
    // the property the union clause exists to state; multiplicity was never part of it.
    //
    // Gated on `regression`, not on "every mode but retest". The residual subtraction this union answers
    // is a `regression` mechanism (Phase 8b human ruling 2). `execute` and `full` accept a batch as an
    // execution record — a capability skills/shared/references/observed-execution.md documents and this
    // branch did not mean to change — but never subtract one from what they drive, so for them
    // `state.executionCases` IS the driven set exactly and an observed entry must contribute nothing here.
    //
    // Measured, so the gate is not mistaken for something it is not: widening it to "every mode but
    // retest" while the residual stays `regression`-only leaves the whole residual suite GREEN, because
    // for `execute`/`full` the intersection it would add is provably empty — their selection IS their
    // driven set, so no selected case is ever undriven for an observed entry to cover. What this gate
    // therefore does today is keep the pre-branch STRICTNESS of those two modes: with the clause active a
    // batch could stand in for a drive that is missing for some other reason, and neither mode ever asked
    // for that. The reverse pairing is the one that bites, and the suite does catch it: widening the
    // residual (src/operations/run-workflow.ts) without widening this reddens the `execute`-mode test with
    // the checkpoint-chain diagnostic. The two gates are one decision and must move together.
    const selectedIds = new Set(array(state?.executionCases).flatMap((item) => isRecord(item) && typeof item.artifactId === "string" ? [item.artifactId] : []));
    const drivenCaseIds = new Set(executionCaseRefs.map((reference) => reference.artifactId));
    const observedSelectedRefs = value.mode !== "regression" ? [] : [...observedCaseIds].filter((id) => selectedIds.has(id) && !drivenCaseIds.has(id)).flatMap((id) => {
      const artifact = artifacts.find((candidate) => candidate.record.id === id);
      return artifact === undefined ? [] : [{ artifactId: artifact.record.id, sha256: artifact.record.sha256 }];
    });
    const selectionOutputRefs = outputs === undefined ? [] : array(outputs["select-regression"]);
    const selectionOutput = selectionOutputRefs.length === 1 && isRecord(selectionOutputRefs[0]) ? selectionOutputRefs[0] : undefined;
    const selectionArtifact = selectionOutput === undefined ? undefined : artifacts.find((artifact) => artifact.valid && artifact.record.type === "regression-selection" && artifact.record.id === selectionOutput.artifactId && artifact.record.sha256 === selectionOutput.sha256);
    const selectedExecutionRefs = selectedExecutionCaseRefs(selectionArtifact, artifacts);
    const selectionStateValid = !completed.includes("select-regression") || (state !== undefined && selectionArtifact !== undefined && selectedExecutionRefs !== undefined && state.selection !== undefined && sameCheckpointRefs([state.selection], selectionOutputRefs) && sameOrderedCheckpointRefs(array(state.executionCases), selectedExecutionRefs));
    const operationStateValid = state !== undefined
      && (!completed.includes("reproduce-bug") || sameCheckpointRefs(array(state.reproductionAttempts), outputs === undefined ? [] : array(outputs["reproduce-bug"])))
      && (!completed.includes("execute-browser-test") || value.mode === "retest" || sameCheckpointRefs(array(state.executionCases), [...executionCaseRefs, ...observedSelectedRefs]))
      && selectionStateValid;
    if (value.runId !== expectedRunId || value.mode !== metadata.mode || value.inputChecksum === undefined || value.stateChecksum === undefined || new Set(completed).size !== completed.length || !outputReferencesValid || !stateReferencesValid || !operationStateValid || !validInitial || !validSuccessor) {
      changed = invalidate(checkpoint, diagnostics, "INVALID_REFERENCE", "Workflow checkpoints must form an immutable revision chain with verified operation outputs") || changed;
    }
  }

  // Hoisted out of the loop rather than rebuilt per iteration: unlike the fixpoint above, this loop
  // cannot shrink the pool it indexes. Every `invalidate` below targets the loop's OWN artifact, which
  // is an `evidence` or `evidence-gap` by construction, so the set of valid `test-result` artifacts is
  // invariant for the whole loop — the same reason the `.filter()` this replaces returned identical
  // results on every call.
  const validResultsByAttempt = indexByAttemptId(
    artifacts.filter((candidate) => candidate.valid && candidate.record.type === "test-result"),
    (candidate) => candidate.value?.attemptId,
  );
  for (const artifact of artifacts.filter((candidate) => candidate.valid && (candidate.record.type === "evidence" || candidate.record.type === "evidence-gap") && candidate.value !== undefined)) {
    const value = artifact.value as Record<string, unknown>;
    if (artifact.record.type === "evidence") {
      // Observed-execution evidence is exempt from the attempt binding because it claims none; the
      // in-fixpoint block above already asserts it references no test result.
      if (evidenceSubject(value)?.kind !== "observed-execution" && !exactAttemptEvidenceBinding(claimedAttemptIdentity(artifact), artifact, artifacts, validResultsByAttempt)) {
        changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Evidence must have one exact test-result relationship and matching testcase identity") || changed;
      }
    } else if (value.scope === "attempt") {
      if (!exactAttemptEvidenceBinding(claimedAttemptIdentity(artifact), artifact, artifacts, validResultsByAttempt)) {
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
      // Canonical POSIX form, not `path.relative`'s native form: `registered` is built from the
      // manifest, which stores `inputs/…` on every platform (see `manifestRelativePath`).
      const relativePath = manifestRelativePath(path, absolutePath);
      if (!registered.has(relativePath)) addDiagnostic(diagnostics, { code: "ORPHAN_FILE", message: `Unregistered file ${relativePath}`, relativePath });
    }
  }
  return { metadata, manifest, artifacts, diagnostics };
}
