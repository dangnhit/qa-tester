import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { parseAuthoringDocument } from "../contracts/authoring.js";
import { artifactTypes, type ArtifactType, type RunStatus } from "../contracts/types.js";
import { formatValidationErrors, validateArtifact } from "../contracts/validator.js";
import { runtimeVersion } from "../installer/manifest.js";
import { deriveTestPlanApproval, type ApprovalDecision, type ApprovalEnvironment } from "../planning/approval.js";
import { assertRequirementAuthorities } from "../planning/authority.js";
import {
  artifactProfileNames,
  artifactProfileVersion,
  assertArtifactProfileName,
  evaluateArtifactProfile,
  type ArtifactProfileName,
} from "./artifact-profiles.js";
import {
  matchesEvidencePrimary,
  terminalStatuses,
  type ArtifactRecord,
  type EvidenceCaptureType,
  type Manifest,
  type WorkspaceDiagnostic,
  type WorkspaceMetadata,
} from "./artifact-record.js";
import { sha256, sha256Bytes, sha256Text } from "./checksum.js";
import { QaSkillsError } from "./errors.js";
import { assertRealpathWithin, atomicWriteFile, isPathWithin, resolveWithin } from "./fs.js";
import { createEntityId, createRunId } from "./ids.js";
import { inspectWorkspaceState } from "./inspect-workspace-state.js";
import { acquireRunLock, type RunLock } from "./run-lock.js";
import { utcNow } from "./time.js";
import { semanticRules, type RelatedArtifact, type SemanticContext } from "./semantic-rules.js";
import { isRecord } from "./values.js";

export type { ArtifactRecord, EvidenceCaptureType, WorkspaceDiagnostic } from "./artifact-record.js";

export type WorkspaceValidation = { valid: boolean; diagnostics: WorkspaceDiagnostic[] };
export type RegisteredWorkspaceArtifact = Readonly<{ record: ArtifactRecord; value: Readonly<Record<string, unknown>> }>;
export type WorkspacePersistence = {
  writeAtomic(root: string, path: string, contents: string | Uint8Array): Promise<void>;
};
export type ExplicitTerminalOutcome = Extract<RunStatus, "COMPLETED_WITH_FAILURES" | "BLOCKED" | "ABORTED">;

const defaultPersistence: WorkspacePersistence = { writeAtomic: atomicWriteFile };
const nextStatuses: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  CREATED: ["RUNNING"],
  RUNNING: ["FINALIZING"],
  FINALIZING: ["COMPLETED", "COMPLETED_WITH_FAILURES", "BLOCKED", "ABORTED"],
  COMPLETED: [],
  COMPLETED_WITH_FAILURES: [],
  BLOCKED: [],
  ABORTED: [],
};

function isArtifactType(value: string): value is ArtifactType {
  return (artifactTypes as readonly string[]).includes(value);
}

/**
 * The one wrap behind `RunWorkspace.open`'s nine reaching CLI commands (`validate`, `approval record`,
 * `attestation record`, `execute playwright`, `export`, the three `artifact ingest` subcommands, and
 * `workflow run --resume-run-id`): a missing project root OR a missing run directory used to surface as
 * a raw `ENOENT` from `realpath` — uncaught by `program.ts`'s `QaSkillsError` branch, so it fell to the
 * generic catch and answered `ABORTED_OR_INTERNAL` (exit 5) with a filesystem path in the message.
 *
 * Takes the refusal message rather than deriving one from a run ID, because the two callers in `open`
 * below are refusing two DIFFERENT bad inputs: a caller-supplied `--root` that does not exist, and a
 * caller-supplied `--run-id` that does not exist under an otherwise-real root. Collapsing both into one
 * "run not found" message would send a `--root` typo hunting for a run ID that was never wrong — the
 * message would still be naming the WRONG argument even after the exit code was fixed.
 *
 * Translates `ENOENT` ONLY, to the same `INVALID_ARTIFACT` refusal `readRunManifestAndMetadata`
 * (`src/cli/workflow.ts`) already gives an unknown `--bug-run-id`/`--source-run-id`/`--resume-run-id`,
 * naming the offending argument rather than the resolved path. Any other errno — a permission error, an
 * I/O error, a symlink-escape `QaSkillsError` from `assertRealpathWithin` itself — is a real fault (or an
 * unrelated, already-coded refusal) and is rethrown untouched: folding it into "not found" would
 * misreport an internal failure as a user typo, which is strictly worse than the crash it replaces.
 */
async function translateMissingRun<T>(message: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new QaSkillsError(message, "INVALID_ARTIFACT");
    }
    throw error;
  }
}

export class RunWorkspace {
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private exclusive = false;
  private exclusivePromise: Promise<unknown> | undefined;
  private readonly activeMutations = new Set<Promise<unknown>>();
  private manifestTail: Promise<void> = Promise.resolve();

  private constructor(
  public readonly root: string,
  public readonly path: string,
  public readonly runId: string,
  public readonly mode: ArtifactProfileName,
    private metadata: WorkspaceMetadata,
    private readonly lock: RunLock | undefined,
    private readonly persistence: WorkspacePersistence,
  ) {}

  /** Immutable source linkage is exposed for linked workflow validation. */
  public get linkedRunId(): string | undefined { return this.metadata.linkedRunId; }

  public static async create(options: {
    root: string;
    mode: ArtifactProfileName;
    environmentProfile: Record<string, unknown>;
    linkedRunId?: string;
    persistence?: WorkspacePersistence;
  }): Promise<RunWorkspace> {
    if (!(artifactProfileNames as readonly string[]).includes(options.mode)) {
      throw new QaSkillsError("Invalid mode", "INVALID_MODE");
    }
    if (!validateArtifact("environment-profile", options.environmentProfile).valid) {
      throw new QaSkillsError("Invalid environment profile", "INVALID_ARTIFACT");
    }
    await mkdir(options.root, { recursive: true });
    const root = await realpath(options.root);
    const resultsPath = resolveWithin(root, "qa-results");
    await mkdir(resultsPath, { recursive: true });
    await assertRealpathWithin(root, "qa-results");
    const runId = createRunId();
    const runCandidate = resolveWithin(root, join("qa-results", runId));
    await mkdir(runCandidate);
    const path = await assertRealpathWithin(root, relative(root, runCandidate));
    const lock = await acquireRunLock(path);
    const profileId = options.environmentProfile.environmentProfileId;
    if (typeof profileId !== "string") throw new QaSkillsError("Environment profile ID is required", "INVALID_ARTIFACT");
    const metadata: WorkspaceMetadata = {
      artifactType: "run-metadata",
      schemaVersion: "1.0.0",
      producerVersion: runtimeVersion,
      runId,
      status: "CREATED",
      createdAt: utcNow(),
      mode: options.mode,
      environmentProfileId: profileId,
      ...(options.linkedRunId ? { linkedRunId: options.linkedRunId } : {}),
    };
    const workspace = new RunWorkspace(
      root,
      path,
      runId,
      options.mode,
      metadata,
      lock,
      options.persistence ?? defaultPersistence,
    );
    await workspace.persistMetadata(metadata);
    await workspace.writeManifest({
      artifactType: "artifact-manifest",
      schemaVersion: "1.0.0",
      producerVersion: runtimeVersion,
      runId,
      artifacts: [],
    });
    await workspace.registerCanonicalArtifact("environment-profile", options.environmentProfile, [], "runtime");
    return workspace;
  }

  public static async open(root: string, runId: string): Promise<RunWorkspace> {
    const realRoot = await translateMissingRun("Project root does not exist", () => realpath(root));
    const path = await translateMissingRun(`Run ${runId} was not found`, () => assertRealpathWithin(realRoot, join("qa-results", runId)));
    const inspected = await inspectWorkspaceState(path, runId, RunWorkspace.reopenRun);
    if (inspected.diagnostics.length > 0) {
      throw new QaSkillsError(`Workspace artifact binding is invalid: ${inspected.diagnostics[0]?.message ?? "unknown error"}`, "ARTIFACT_BINDING");
    }
    const lock = terminalStatuses.has(inspected.metadata.status) ? undefined : await acquireRunLock(path);
    return new RunWorkspace(realRoot, path, runId, inspected.metadata.mode, inspected.metadata, lock, defaultPersistence);
  }

  /** Read-path cross-run reopen, injected into `inspectWorkspaceState` to break its mutual recursion
   *  with `open` — the extracted `inspect-workspace-state` module imports nothing from this file and
   *  reopens a DISTINCT run only through this adapter. Declared as an arrow (not a bare `open` method
   *  reference) so it carries no `this` and satisfies `@typescript-eslint/unbound-method`. */
  private static readonly reopenRun = (root: string, runId: string): Promise<RunWorkspace> =>
    RunWorkspace.open(root, runId);

  public async resolve(relativePath: string): Promise<string> {
    this.assertOpen();
    return assertRealpathWithin(this.path, relativePath);
  }

  public registerArtifact(input: {
    type: ArtifactType;
    sourcePath: string;
    relationships: string[];
    provenance?: string;
  }): Promise<ArtifactRecord & { absolutePath: string }> {
    try {
      this.assertWritable();
      if (!isArtifactType(input.type)) throw new QaSkillsError("Unsupported artifact type", "INVALID_ARTIFACT");
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return this.trackMutation(async () => {
      const sourcePath = resolve(input.sourcePath);
      const sourceRelative = relative(this.path, sourcePath);
      // Only a source INSIDE the workspace goes through the symlink-containment guard. A source
      // outside it is a legitimate registration input — a spec or fixture elsewhere in the repo — and
      // must be left to `stat` below. Delegating the decision to `isPathWithin` rather than
      // re-deriving it keeps the two in step: the hand-rolled `!startsWith("/")` test admitted a
      // Windows source on ANOTHER DRIVE, which relative-izes to `D:\…` rather than to `..\…`, and
      // once `isPathWithin` learned to reject cross-drive candidates that guard would have sent a
      // valid registration into `assertRealpathWithin` and failed it with PATH_ESCAPE.
      if (isPathWithin(this.path, sourcePath)) {
        await assertRealpathWithin(this.path, sourceRelative);
      }
      const sourceStats = await stat(sourcePath);
      if (!sourceStats.isFile()) throw new QaSkillsError("Artifact source must be a file", "INVALID_ARTIFACT");
      const source = await readFile(sourcePath, "utf8");
      const format = sourcePath.endsWith(".yaml") || sourcePath.endsWith(".yml") ? "yaml" : "json";
      const value = parseAuthoringDocument(source, format);
      const result = validateArtifact(input.type, value);
      if (!result.valid) {
        throw new QaSkillsError(`Artifact does not match its contract: ${formatValidationErrors(result.errors)}`, "INVALID_ARTIFACT");
      }
      return this.registerArtifactValueInternal({
        type: input.type,
        value,
        relationships: input.relationships,
        ...(input.provenance ? { provenance: input.provenance } : {}),
      });
    });
  }

  public registerArtifactValue(input: {
    type: ArtifactType;
    value: unknown;
    relationships: string[];
    provenance?: string;
  }): Promise<ArtifactRecord & { absolutePath: string }> {
    let snapshot: unknown;
    let relationships: string[];
    try {
      snapshot = JSON.parse(JSON.stringify(input.value)) as unknown;
      relationships = [...input.relationships];
      this.assertWritable();
      if (!isArtifactType(input.type)) throw new QaSkillsError("Unsupported artifact type", "INVALID_ARTIFACT");
      const result = validateArtifact(input.type, snapshot);
      if (!result.valid) {
        throw new QaSkillsError(`Artifact does not match its contract: ${formatValidationErrors(result.errors)}`, "INVALID_ARTIFACT");
      }
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return this.trackMutation(() => this.registerArtifactValueInternal({
      type: input.type,
      value: snapshot,
      relationships,
      ...(input.provenance ? { provenance: input.provenance } : {}),
    }));
  }

  /** Registers an ordered dependency set with one manifest commit; any failure removes every staged artifact. */
  public registerArtifactValueBatch(inputs: readonly {
    key: string;
    type: ArtifactType;
    value: unknown;
    relationshipKeys?: readonly string[];
    referenceFields?: Readonly<Record<string, string>>;
    relationships?: readonly string[];
    provenance?: string;
  }[]): Promise<ReadonlyMap<string, ArtifactRecord & { absolutePath: string }>> {
    try {
      this.assertWritable();
      if (inputs.length === 0 || new Set(inputs.map((input) => input.key)).size !== inputs.length) throw new QaSkillsError("Artifact batch keys must be non-empty and unique", "INVALID_ARTIFACT");
      for (const input of inputs) {
        if (input.key.length === 0 || !isArtifactType(input.type)) throw new QaSkillsError("Artifact batch does not match its contract", "INVALID_ARTIFACT");
        const result = validateArtifact(input.type, input.value);
        if (!result.valid) throw new QaSkillsError(`Artifact batch entry '${input.key}' (${input.type}) does not match its contract: ${formatValidationErrors(result.errors)}`, "INVALID_ARTIFACT");
      }
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return this.trackMutation(() => this.withManifestTransaction(async () => {
      const original = await this.readManifest();
      let virtual = original;
      const records = new Map<string, ArtifactRecord & { absolutePath: string }>();
      const written: string[] = [];
      try {
        for (const input of inputs) {
          const snapshot = JSON.parse(JSON.stringify(input.value)) as unknown;
          const relationships = [
            ...(input.relationships ?? []),
            ...(input.relationshipKeys ?? []).map((key) => {
              const record = records.get(key);
              if (!record) throw new QaSkillsError(`Artifact batch dependency ${key} is not registered before ${input.key}`, "ARTIFACT_BINDING");
              return record.id;
            }),
          ];
          if (input.referenceFields !== undefined) {
            if (!isRecord(snapshot)) throw new QaSkillsError("Artifact batch reference fields require an object value", "ARTIFACT_BINDING");
            for (const [field, key] of Object.entries(input.referenceFields)) {
              const record = records.get(key);
              if (!record) throw new QaSkillsError(`Artifact batch reference ${key} is not registered before ${input.key}`, "ARTIFACT_BINDING");
              snapshot[field] = record.id;
            }
          }
          const value = input.type === "test-plan" ? await this.withDerivedTestPlanApproval(snapshot, virtual) : snapshot;
          await this.assertArtifactBinding(input.type, value, relationships, virtual);
          const contents = `${JSON.stringify(value, null, 2)}\n`;
          const checksum = sha256Text(contents);
          if (virtual.artifacts.some((artifact) => artifact.type === input.type && artifact.sha256 === checksum)) throw new QaSkillsError("Completed artifacts are immutable; duplicate artifact", "DUPLICATE_ARTIFACT");
          const id = createEntityId();
          const relativePath = `inputs/${id}-${input.type}.json`;
          const absolutePath = resolveWithin(this.path, relativePath);
          written.push(absolutePath);
          await this.persistence.writeAtomic(this.path, absolutePath, contents);
          if (await sha256(absolutePath) !== checksum) throw new QaSkillsError("Atomic artifact batch write checksum mismatch", "WRITE_FAILURE");
          const manifestRecord: ArtifactRecord = { id, type: input.type, relativePath, sha256: checksum, provenance: input.provenance ?? "agent-draft", relationships };
          records.set(input.key, { ...manifestRecord, absolutePath });
          virtual = { ...virtual, artifacts: [...virtual.artifacts, manifestRecord] };
        }
        await this.writeManifest(virtual);
        return records;
      } catch (error) {
        await Promise.all(written.map((path) => rm(path, { force: true })));
        throw error;
      }
    }));
  }

  /** Atomically writes a media artifact inside the workspace and immediately records it in the authoritative manifest. */
  public registerBinaryArtifact(input: {
    type: "evidence";
    filename: string;
    contents: Uint8Array;
    mediaType: string;
    captureType: EvidenceCaptureType;
    dimensions?: { width: number; height: number };
    relationships: string[];
    provenance?: string;
  }): Promise<ArtifactRecord & { absolutePath: string }> {
    try {
      this.assertWritable();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.filename) || input.contents.byteLength === 0) throw new QaSkillsError("Binary artifact filename or contents are invalid", "INVALID_ARTIFACT");
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return this.trackMutation(() => this.withManifestTransaction(async () => {
      const manifest = await this.readManifest();
      const unknownRelationship = input.relationships.find((relationship) => !manifest.artifacts.some((artifact) => artifact.id === relationship));
      if (unknownRelationship) throw new QaSkillsError(`Relationship ${unknownRelationship} is not registered in this workspace`, "ARTIFACT_BINDING");
      const id = createEntityId();
      const relativePath = `evidence/${id}-${input.filename}`;
      const absolutePath = resolveWithin(this.path, relativePath);
      await atomicWriteFile(this.path, absolutePath, input.contents);
      const checksum = await sha256(absolutePath);
      const record: ArtifactRecord = {
        id, type: input.type, relativePath, sha256: checksum, mediaType: input.mediaType, captureType: input.captureType,
        ...(input.dimensions === undefined ? {} : { dimensions: { ...input.dimensions } }), provenance: input.provenance ?? "runtime", relationships: [...input.relationships],
      };
      try {
        await this.writeManifest({ ...manifest, artifacts: [...manifest.artifacts, record] });
      } catch (error) {
        await rm(absolutePath, { force: true });
        throw error;
      }
      return { ...record, absolutePath };
    }));
  }

  /** Writes evidence media and its canonical descriptor as one serialized manifest transaction. */
  public registerEvidenceBundle(input: {
    binaries: readonly {
      filename: string;
      contents: Uint8Array;
      mediaType: string;
      captureType: EvidenceCaptureType;
      dimensions?: { width: number; height: number };
    }[];
    descriptor: (binaries: readonly ArtifactRecord[]) => unknown;
    relationships?: string[];
    provenance?: string;
  }): Promise<{ binaries: readonly (ArtifactRecord & { absolutePath: string })[]; descriptor: ArtifactRecord & { absolutePath: string } }> {
    try {
      this.assertWritable();
      if (input.binaries.length === 0 || input.binaries.some((binary) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(binary.filename) || binary.contents.byteLength === 0)) throw new QaSkillsError("Evidence bundle binary is invalid", "INVALID_ARTIFACT");
    } catch (error: unknown) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    return this.trackMutation(() => this.withManifestTransaction(async () => {
      const manifest = await this.readManifest();
      const written: string[] = [];
      try {
        const planned = input.binaries.map((binary) => {
          const id = createEntityId();
          const relativePath = `evidence/${id}-${binary.filename}`;
          return { id, type: "evidence" as const, relativePath, sha256: sha256Bytes(binary.contents), mediaType: binary.mediaType, captureType: binary.captureType, ...(binary.dimensions === undefined ? {} : { dimensions: { ...binary.dimensions } }), provenance: input.provenance ?? "runtime", relationships: [] };
        });
        const value = input.descriptor(planned);
        if (!validateArtifact("evidence", value).valid) throw new QaSkillsError("Evidence descriptor does not match its contract", "INVALID_ARTIFACT");
        const relationships = [...(input.relationships ?? []), ...planned.map((binary) => binary.id)];
        const details = isRecord(value) ? value.binaryArtifacts : undefined;
        const ids = isRecord(value) ? value.binaryArtifactIds : undefined;
        if (!Array.isArray(ids) || !Array.isArray(details) || ids.length !== planned.length || details.length !== planned.length || !planned.every((binary, index) => ids[index] === binary.id && isRecord(details[index]) && details[index].id === binary.id && details[index].relativePath === binary.relativePath && details[index].sha256 === binary.sha256 && details[index].mediaType === binary.mediaType)) throw new QaSkillsError("Evidence bundle descriptor does not exactly reference its proposed binaries", "ARTIFACT_BINDING");
        const primary = planned[0];
        if (!primary || !matchesEvidencePrimary(value as Record<string, unknown>, primary)) throw new QaSkillsError("Evidence bundle descriptor does not match its designated primary binary", "ARTIFACT_BINDING");
        const withBinaries: Manifest = { ...manifest, artifacts: [...manifest.artifacts, ...planned] };
        await this.assertArtifactBinding("evidence", value, relationships, withBinaries);
        const canonicalContents = `${JSON.stringify(value, null, 2)}\n`;
        const checksum = sha256Text(canonicalContents);
        if (manifest.artifacts.some((artifact) => artifact.type === "evidence" && artifact.sha256 === checksum)) throw new QaSkillsError("Completed artifacts are immutable; duplicate artifact", "DUPLICATE_ARTIFACT");
        const descriptorId = createEntityId();
        const relativePath = `inputs/${descriptorId}-evidence.json`;
        const absolutePath = resolveWithin(this.path, relativePath);
        const binaries: (ArtifactRecord & { absolutePath: string })[] = [];
        for (const [index, binary] of input.binaries.entries()) {
          const record = planned[index];
          if (!record) throw new QaSkillsError("Evidence bundle planning failed", "WRITE_FAILURE");
          const binaryPath = resolveWithin(this.path, record.relativePath);
          written.push(binaryPath);
          await this.persistence.writeAtomic(this.path, binaryPath, binary.contents);
          if (await sha256(binaryPath) !== record.sha256) throw new QaSkillsError("Atomic evidence binary write checksum mismatch", "WRITE_FAILURE");
          binaries.push({ ...record, absolutePath: binaryPath });
        }
        written.push(absolutePath);
        await this.persistence.writeAtomic(this.path, absolutePath, canonicalContents);
        if (await sha256(absolutePath) !== checksum) throw new QaSkillsError("Atomic evidence descriptor write checksum mismatch", "WRITE_FAILURE");
        const descriptor: ArtifactRecord = { id: descriptorId, type: "evidence", relativePath, sha256: checksum, provenance: input.provenance ?? "runtime", relationships };
        await this.writeManifest({ ...withBinaries, artifacts: [...withBinaries.artifacts, descriptor] });
        return { binaries, descriptor: { ...descriptor, absolutePath } };
      } catch (error) {
        await Promise.all(written.map((path) => rm(path, { force: true })));
        throw error;
      }
    }));
  }

  private registerArtifactValueInternal(input: {
    type: ArtifactType;
    value: unknown;
    relationships: string[];
    provenance?: string;
  }): Promise<ArtifactRecord & { absolutePath: string }> {
    return this.withManifestTransaction(async () => {
      const manifest = await this.readManifest();
      const value = input.type === "test-plan"
        ? await this.withDerivedTestPlanApproval(input.value, manifest)
        : input.value;
      await this.assertArtifactBinding(input.type, value, input.relationships, manifest);
      return this.registerCanonicalArtifact(
        input.type,
        value,
        input.relationships,
        input.provenance ?? "agent-draft",
        manifest,
      );
    });
  }

  public transition(status: RunStatus): Promise<void> {
    try {
      this.assertWritable();
      if (status !== "RUNNING" || this.metadata.status !== "CREATED") {
        throw new QaSkillsError(`Lifecycle transition ${this.metadata.status} -> ${status} is reserved for finalize`, "ILLEGAL_TRANSITION");
      }
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return this.trackMutation(() => this.transitionInternal(status));
  }

  public async validate(profile: ArtifactProfileName = this.mode): Promise<WorkspaceValidation> {
    this.assertOpen();
    return this.validateInternal(profile);
  }

  /** Returns only freshly revalidated, manifest-registered immutable payloads. */
  public async readRegisteredArtifacts(): Promise<readonly RegisteredWorkspaceArtifact[]> {
    this.assertOpen();
    const inspected = await inspectWorkspaceState(this.path, this.runId, RunWorkspace.reopenRun);
    if (inspected.diagnostics.length > 0) {
      throw new QaSkillsError(`Workspace artifact binding is invalid: ${inspected.diagnostics[0]?.message ?? "unknown error"}`, "ARTIFACT_BINDING");
    }
    return inspected.artifacts.flatMap((artifact) => artifact.valid && artifact.value
      ? [{ record: artifact.record, value: artifact.value }]
      : []);
  }

  /** Returns a freshly validated manifest record, including registered evidence binaries. */
  public async readArtifactRecord(id: string): Promise<Readonly<ArtifactRecord>> {
    this.assertOpen();
    const inspected = await inspectWorkspaceState(this.path, this.runId, RunWorkspace.reopenRun);
    if (inspected.diagnostics.length > 0) throw new QaSkillsError(`Workspace artifact binding is invalid: ${inspected.diagnostics[0]?.message ?? "unknown error"}`, "ARTIFACT_BINDING");
    const record = inspected.manifest.artifacts.find((artifact) => artifact.id === id);
    if (!record) throw new QaSkillsError("Registered artifact was not found", "ARTIFACT_BINDING");
    return { ...record, relationships: [...record.relationships] };
  }

  public finalize(
    profile: ArtifactProfileName = this.mode,
    outcome?: ExplicitTerminalOutcome,
  ): Promise<WorkspaceValidation> {
    try {
      this.assertWritable();
      assertArtifactProfileName(profile);
      if (profile !== this.mode) {
        throw new QaSkillsError(`Finalization profile ${profile} does not match run mode ${this.mode}`, "INVALID_PROFILE");
      }
      if (outcome !== undefined && outcome !== "COMPLETED_WITH_FAILURES" && outcome !== "BLOCKED" && outcome !== "ABORTED") {
        throw new QaSkillsError(`Unsupported terminal outcome ${String(outcome)}`, "ILLEGAL_TRANSITION");
      }
      if (this.exclusive) throw new QaSkillsError("Workspace is already finalizing", "ILLEGAL_TRANSITION");
      this.exclusive = true;
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    const operation = this.finalizeInternal(profile, outcome);
    this.exclusivePromise = operation;
    void operation.then(
      () => {
        this.exclusivePromise = undefined;
      },
      () => {
        this.exclusivePromise = undefined;
        if (!terminalStatuses.has(this.metadata.status)) this.exclusive = false;
      },
    );
    return operation;
  }

  public close(): Promise<void> {
    this.closed = true;
    if (!this.closePromise) {
      this.closePromise = (async () => {
        while (this.activeMutations.size > 0) {
          await Promise.allSettled([...this.activeMutations]);
        }
        if (this.exclusivePromise) await Promise.allSettled([this.exclusivePromise]);
        await this.lock?.release();
      })().catch((error: unknown) => {
        this.closePromise = undefined;
        throw error;
      });
    }
    return this.closePromise;
  }

  private async finalizeInternal(
    profile: ArtifactProfileName,
    outcome?: ExplicitTerminalOutcome,
  ): Promise<WorkspaceValidation> {
    while (this.activeMutations.size > 0) await Promise.all([...this.activeMutations]);
    if (this.metadata.status === "CREATED") await this.transitionInternal("RUNNING");
    if (this.metadata.status !== "RUNNING") {
      throw new QaSkillsError(`Cannot finalize a ${this.metadata.status} workspace`, "ILLEGAL_TRANSITION");
    }
    const result = await this.validateInternal(profile);
    await this.transitionInternal("FINALIZING");
    const terminal = outcome ?? (result.valid ? "COMPLETED" : "COMPLETED_WITH_FAILURES");
    await this.transitionTerminal(terminal, profile);
    return result;
  }

  private async validateInternal(profile: ArtifactProfileName): Promise<WorkspaceValidation> {
    assertArtifactProfileName(profile);
    const inspected = await inspectWorkspaceState(this.path, this.runId, RunWorkspace.reopenRun);
    const diagnostics = [...inspected.diagnostics];
    const validTypes = inspected.artifacts
      .filter((artifact) => artifact.valid)
      .map((artifact) => artifact.record.type);
    diagnostics.push(...evaluateArtifactProfile(profile, ["run-metadata", ...validTypes]).diagnostics);
    return { valid: diagnostics.length === 0, diagnostics };
  }

  private assertOpen(): void {
    if (this.closed) throw new QaSkillsError("Workspace is closed", "CLOSED_WORKSPACE");
  }

  private assertWritable(): void {
    this.assertOpen();
    if (terminalStatuses.has(this.metadata.status)) {
      throw new QaSkillsError("Terminal workspace is immutable", "TERMINAL_WORKSPACE");
    }
    if (this.exclusive || this.metadata.status === "FINALIZING") {
      throw new QaSkillsError("Workspace is finalizing and rejects new writes", "FINALIZING_WORKSPACE");
    }
  }

  private trackMutation<T>(operation: () => Promise<T>): Promise<T> {
    const promise = operation();
    this.activeMutations.add(promise);
    void promise.then(
      () => this.activeMutations.delete(promise),
      () => this.activeMutations.delete(promise),
    );
    return promise;
  }

  private withManifestTransaction<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.manifestTail.then(operation, operation);
    this.manifestTail = current.then(() => undefined, () => undefined);
    return current;
  }

  private async assertArtifactBinding(
    type: ArtifactType,
    value: unknown,
    relationships: string[],
    manifest: Manifest,
  ): Promise<void> {
    if (!isRecord(value)) throw new QaSkillsError("Artifact binding requires an object", "ARTIFACT_BINDING");
    if (Object.hasOwn(value, "runId") && value.runId !== this.runId) {
      throw new QaSkillsError("Artifact run ID does not match this workspace", "ARTIFACT_BINDING");
    }
    if (Object.hasOwn(value, "environmentProfileId") && value.environmentProfileId !== this.metadata.environmentProfileId) {
      throw new QaSkillsError("Artifact environment profile ID does not match this workspace", "ARTIFACT_BINDING");
    }
    if (type === "environment-profile") {
      if (value.environmentProfileId !== this.metadata.environmentProfileId) {
        throw new QaSkillsError("Environment profile does not match this workspace", "ARTIFACT_BINDING");
      }
      if (manifest.artifacts.some((artifact) => artifact.type === "environment-profile")) {
        throw new QaSkillsError("The workspace already has an authoritative environment profile", "ARTIFACT_BINDING");
      }
    }
    const knownIds = new Set(manifest.artifacts.map((artifact) => artifact.id));
    const unknownRelationship = relationships.find((relationship) => !knownIds.has(relationship));
    if (unknownRelationship) {
      throw new QaSkillsError(`Relationship ${unknownRelationship} is not registered in this workspace`, "ARTIFACT_BINDING");
    }
    await this.assertSemanticReferences(type, value, relationships, manifest);
  }

  private async transitionInternal(status: RunStatus): Promise<void> {
    if (terminalStatuses.has(status)) {
      throw new QaSkillsError("Terminal transitions require finalization", "ILLEGAL_TRANSITION");
    }
    if (!nextStatuses[this.metadata.status].includes(status)) {
      throw new QaSkillsError(`Illegal lifecycle transition: ${this.metadata.status} -> ${status}`, "ILLEGAL_TRANSITION");
    }
    const next = { ...this.metadata, status };
    await this.persistMetadata(next);
    this.metadata = next;
  }

  private async transitionTerminal(
    status: Extract<RunStatus, "COMPLETED" | "COMPLETED_WITH_FAILURES" | "BLOCKED" | "ABORTED">,
    profile: ArtifactProfileName,
  ): Promise<void> {
    if (!nextStatuses[this.metadata.status].includes(status)) {
      throw new QaSkillsError(`Illegal lifecycle transition: ${this.metadata.status} -> ${status}`, "ILLEGAL_TRANSITION");
    }
    const terminal: WorkspaceMetadata = {
      ...this.metadata,
      status,
      finalizedProfile: { name: profile, version: artifactProfileVersion },
    };
    try {
      await this.persistMetadata(terminal);
      this.metadata = terminal;
    } catch (error: unknown) {
      const running: WorkspaceMetadata = { ...this.metadata, status: "RUNNING" };
      delete running.finalizedProfile;
      await this.persistMetadata(running);
      this.metadata = running;
      throw error;
    }
    await this.lock?.release();
  }

  private async readRegisteredValues(manifest: Manifest, type: ArtifactType): Promise<Record<string, unknown>[]> {
    return Promise.all(manifest.artifacts.filter((artifact) => artifact.type === type && artifact.mediaType === undefined).map(async (artifact) => {
      const path = await assertRealpathWithin(this.path, artifact.relativePath);
      if (await sha256(path) !== artifact.sha256) {
        throw new QaSkillsError(`Referenced ${type} checksum mismatch`, "ARTIFACT_BINDING");
      }
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!isRecord(value) || !validateArtifact(type, value).valid) {
        throw new QaSkillsError(`Referenced ${type} is invalid`, "ARTIFACT_BINDING");
      }
      return value;
    }));
  }

  /** Pairs `manifest.artifacts.filter(type && mediaType===undefined)` with `readRegisteredValues`
   *  (which applies the identical filter, in manifest order), so record[i] corresponds to value[i].
   *  Asserts equal length to fail loudly if the two filters ever diverge (design §8 risk 4). */
  private async readRegisteredRelated(manifest: Manifest, type: ArtifactType): Promise<readonly RelatedArtifact[]> {
    const records = manifest.artifacts.filter((artifact) => artifact.type === type && artifact.mediaType === undefined);
    const values = await this.readRegisteredValues(manifest, type);
    if (records.length !== values.length) {
      throw new QaSkillsError("Registered artifact record/value pairing is inconsistent", "ARTIFACT_BINDING");
    }
    return records.map((record, index): RelatedArtifact => {
      const value = values[index];
      return value === undefined ? { record } : { record, value };
    });
  }

  /** Builds the WRITE-path `SemanticContext`. The related-artifact pool is re-read from disk, where
   *  every referenced artifact is valid by construction (registration is serialized), so there is no
   *  cascade on write. `self` is a synthetic record (the artifact is not yet in the manifest). Only
   *  the type dispatched by `runSemanticRule` reaches here, so this is built solely for migrated
   *  types; the related pool is pre-read once per distinct registered non-media type. */
  private async buildWriteContext(
    type: ArtifactType,
    value: Record<string, unknown>,
    relationships: string[],
    manifest: Manifest,
  ): Promise<SemanticContext> {
    const byType = new Map<ArtifactType, readonly RelatedArtifact[]>();
    for (const relatedType of new Set(manifest.artifacts.filter((artifact) => artifact.mediaType === undefined).map((artifact) => artifact.type))) {
      byType.set(relatedType, await this.readRegisteredRelated(manifest, relatedType));
    }
    const self: ArtifactRecord = { id: "", type, relativePath: "", sha256: "", provenance: "", relationships: [...relationships] };
    return {
      stage: "write",
      type,
      value,
      self,
      relationships,
      runId: this.runId,
      path: this.path,
      root: this.root,
      linkedRunId: this.metadata.linkedRunId,
      environmentProfileId: this.metadata.environmentProfileId,
      mode: this.mode,
      relatedOfType: (relatedType) => byType.get(relatedType) ?? [],
      related: () => [...byType.values()].flat(),
      registeredRecord: (id, relatedType) => manifest.artifacts.find((artifact) => artifact.id === id && (relatedType === undefined || artifact.type === relatedType)),
      openRun: (runId) => RunWorkspace.open(this.root, runId),
    };
  }

  /** Write-path adapter (finalized): every write-semantic type now lives in the shared
   *  `semanticRules` table, so this is purely the rule dispatch — no legacy `if/else` chain remains.
   *  Looks up the rule for `type`, runs it against the write context, and throws
   *  `QaSkillsError(v.message, v.code)` on a violation. Types without a write rule (e.g.
   *  `change-scope`, `workflow-checkpoint`, the no-rule types, and `environment-profile` — whose
   *  semantic binding is handled inline in `assertArtifactBinding`) are simply not dispatched. The
   *  universal `runId`/`environmentProfileId` binding stays in `assertArtifactBinding`, not the table. */
  private async assertSemanticReferences(
    type: ArtifactType,
    value: Record<string, unknown>,
    relationships: string[],
    manifest: Manifest,
  ): Promise<void> {
    const rule = semanticRules[type];
    if (!rule || !rule.appliesTo.write) return;
    const violation = await rule.evaluate(await this.buildWriteContext(type, value, relationships, manifest));
    if (violation) throw new QaSkillsError(violation.message, violation.code);
  }

  private async withDerivedTestPlanApproval(value: unknown, manifest: Manifest): Promise<Record<string, unknown>> {
    if (!isRecord(value)) throw new QaSkillsError("Test plan policy is invalid", "ARTIFACT_BINDING");
    if (value.approvalDecision !== undefined) {
      throw new QaSkillsError("Test plan approval decision is derived by workspace registration and cannot be self-asserted", "ARTIFACT_BINDING");
    }
    const decision = await this.assertTestPlanPolicy(value, manifest);
    return { ...value, approvalDecision: decision };
  }

  private async assertTestPlanPolicy(value: Record<string, unknown>, manifest: Manifest): Promise<ApprovalDecision> {
    const requirements = await this.readRegisteredValues(manifest, "requirement-analysis");
    for (const analysis of requirements) {
      try {
        assertRequirementAuthorities(analysis);
      } catch (error: unknown) {
        throw new QaSkillsError(error instanceof Error ? error.message : "Registered requirement authority is invalid", "ARTIFACT_BINDING");
      }
    }
    const environments = await this.readRegisteredValues(manifest, "environment-profile");
    const environment = environments.length === 1 && typeof environments[0]?.classification === "string"
      ? { classification: environments[0].classification } as ApprovalEnvironment
      : undefined;
    if (!environment) throw new QaSkillsError("Test plan requires one authoritative environment profile", "ARTIFACT_BINDING");
    let decision: ApprovalDecision;
    try {
      decision = deriveTestPlanApproval({ plan: value, requirementAnalyses: requirements, environment });
    } catch (error: unknown) {
      throw new QaSkillsError(error instanceof Error ? error.message : "Test plan approval derivation failed", "ARTIFACT_BINDING");
    }
    const persisted = value.approvalDecision;
    if (persisted !== undefined && JSON.stringify(persisted) !== JSON.stringify(decision)) {
      throw new QaSkillsError("Persisted test plan approval decision does not equal the derived decision", "ARTIFACT_BINDING");
    }
    if (!decision.approved && isRecord(value.approvalPolicy) && value.approvalPolicy.mode === "auto-approve-safe") {
      throw new QaSkillsError(`Unsafe auto-approval: ${decision.reasons.join(", ")}`, "UNSAFE_OPERATION");
    }
    return decision;
  }

  private async registerCanonicalArtifact(
    type: ArtifactType,
    value: unknown,
    relationships: string[],
    provenance: string,
    currentManifest?: Manifest,
  ): Promise<ArtifactRecord & { absolutePath: string }> {
    const canonicalContents = `${JSON.stringify(value, null, 2)}\n`;
    const checksum = sha256Text(canonicalContents);
    const manifest = currentManifest ?? await this.readManifest();
    if (manifest.artifacts.some((artifact) => artifact.type === type && artifact.sha256 === checksum)) {
      throw new QaSkillsError("Completed artifacts are immutable; duplicate artifact", "DUPLICATE_ARTIFACT");
    }
    const id = createEntityId();
    const relativePath = `inputs/${id}-${type}.json`;
    const absolutePath = resolveWithin(this.path, relativePath);
    await this.persistence.writeAtomic(this.path, absolutePath, canonicalContents);
    if (await sha256(absolutePath) !== checksum) {
      throw new QaSkillsError("Atomic artifact write checksum mismatch", "WRITE_FAILURE");
    }
    const record: ArtifactRecord = {
      id,
      type,
      relativePath,
      sha256: checksum,
      provenance,
      relationships: [...relationships],
    };
    try {
      await this.writeManifest({ ...manifest, artifacts: [...manifest.artifacts, record] });
    } catch (error: unknown) {
      await rm(absolutePath, { force: true });
      throw error;
    }
    return { ...record, absolutePath };
  }

  private async readManifest(): Promise<Manifest> {
    const path = await assertRealpathWithin(this.path, "artifact-manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8")) as Manifest;
    if (!validateArtifact("artifact-manifest", manifest).valid) {
      throw new QaSkillsError("Invalid artifact manifest", "INVALID_MANIFEST");
    }
    if (manifest.runId !== this.runId) {
      throw new QaSkillsError("Manifest run ID does not match this workspace", "ARTIFACT_BINDING");
    }
    return manifest;
  }

  private async persistMetadata(metadata: WorkspaceMetadata): Promise<void> {
    await this.persistence.writeAtomic(
      this.path,
      resolveWithin(this.path, "run-metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  }

  private async writeManifest(manifest: Manifest): Promise<void> {
    await this.persistence.writeAtomic(
      this.path,
      resolveWithin(this.path, "artifact-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
}
