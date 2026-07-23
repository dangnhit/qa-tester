import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { parseAuthoringDocument } from "../contracts/authoring.js";
import { artifactTypes, type ArtifactType, type RunStatus } from "../contracts/types.js";
import { validateArtifact } from "../contracts/validator.js";
import {
  artifactProfileNames,
  artifactProfileVersion,
  assertArtifactProfileName,
  evaluateArtifactProfile,
  type ArtifactProfileName,
} from "./artifact-profiles.js";
import { sha256, sha256Text } from "./checksum.js";
import { QaSkillsError } from "./errors.js";
import { assertPathWithin, assertRealpathWithin, atomicWriteFile, resolveWithin } from "./fs.js";
import { createEntityId, createRunId } from "./ids.js";
import { acquireRunLock, type RunLock } from "./run-lock.js";
import { utcNow } from "./time.js";

export type ArtifactRecord = {
  id: string;
  type: ArtifactType;
  relativePath: string;
  sha256: string;
  provenance: string;
  relationships: string[];
};

type WorkspaceMetadata = {
  artifactType: "run-metadata";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  status: RunStatus;
  createdAt: string;
  mode: ArtifactProfileName;
  environmentProfileId: string;
  finalizedProfile?: { name: ArtifactProfileName; version: typeof artifactProfileVersion };
  linkedRunId?: string;
};

type Manifest = {
  artifactType: "artifact-manifest";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  artifacts: ArtifactRecord[];
};

export type WorkspaceDiagnostic = { code: string; message: string; relativePath?: string };
export type WorkspaceValidation = { valid: boolean; diagnostics: WorkspaceDiagnostic[] };

const terminalStatuses = new Set<RunStatus>(["COMPLETED", "COMPLETED_WITH_FAILURES", "BLOCKED", "ABORTED"]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function filesUnder(root: string, directory: string): Promise<string[]> {
  await assertPathWithin(root, directory);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
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

export class RunWorkspace {
  private constructor(
    public readonly root: string,
    public readonly path: string,
    public readonly runId: string,
    public readonly mode: ArtifactProfileName,
    private metadata: WorkspaceMetadata,
    private readonly lock: RunLock | undefined,
  ) {}

  private closed = false;

  public static async create(options: { root: string; mode: ArtifactProfileName; environmentProfile: Record<string, unknown>; linkedRunId?: string }): Promise<RunWorkspace> {
    if (!(artifactProfileNames as readonly string[]).includes(options.mode)) throw new QaSkillsError("Invalid mode", "INVALID_MODE");
    if (!validateArtifact("environment-profile", options.environmentProfile).valid) throw new QaSkillsError("Invalid environment profile", "INVALID_ARTIFACT");
    await mkdir(options.root, { recursive: true });
    const root = await realpath(options.root);
    const resultsPath = resolveWithin(root, "qa-results");
    await assertPathWithin(root, resultsPath);
    await mkdir(resultsPath, { recursive: true });
    await assertRealpathWithin(root, "qa-results");
    const runId = createRunId();
    const runCandidate = resolveWithin(root, join("qa-results", runId));
    await assertPathWithin(root, runCandidate);
    await mkdir(runCandidate);
    const path = await assertRealpathWithin(root, relative(root, runCandidate));
    const lock = await acquireRunLock(path);
    const profileId = options.environmentProfile.environmentProfileId;
    if (typeof profileId !== "string") throw new QaSkillsError("Environment profile ID is required", "INVALID_ARTIFACT");
    const metadata: WorkspaceMetadata = {
      artifactType: "run-metadata", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId,
      status: "CREATED", createdAt: utcNow(), mode: options.mode, environmentProfileId: profileId,
      ...(options.linkedRunId ? { linkedRunId: options.linkedRunId } : {}),
    };
    const workspace = new RunWorkspace(root, path, runId, options.mode, metadata, lock);
    await workspace.writeMetadata();
    await workspace.writeManifest({ artifactType: "artifact-manifest", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId, artifacts: [] });
    await workspace.registerCanonicalArtifact("environment-profile", options.environmentProfile, [], "runtime");
    return workspace;
  }

  public static async open(root: string, runId: string): Promise<RunWorkspace> {
    const realRoot = await realpath(root);
    const path = await assertRealpathWithin(realRoot, join("qa-results", runId));
    const metadataPath = await assertRealpathWithin(path, "run-metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as WorkspaceMetadata;
    if (!validateArtifact("run-metadata", metadata).valid) throw new QaSkillsError("Invalid workspace metadata", "INVALID_ARTIFACT");
    const lock = terminalStatuses.has(metadata.status) ? undefined : await acquireRunLock(path);
    return new RunWorkspace(realRoot, path, runId, metadata.mode, metadata, lock);
  }

  public async resolve(relativePath: string): Promise<string> {
    this.assertOpen();
    return assertRealpathWithin(this.path, relativePath);
  }

  public async registerArtifact(input: { type: ArtifactType; sourcePath: string; relationships: string[]; provenance?: string }): Promise<ArtifactRecord & { absolutePath: string }> {
    this.assertWritable();
    if (!isArtifactType(input.type)) throw new QaSkillsError("Unsupported artifact type", "INVALID_ARTIFACT");
    const sourcePath = resolve(input.sourcePath);
    const sourceRelative = relative(this.path, sourcePath);
    if (sourceRelative === "" || (!sourceRelative.startsWith("..") && !sourceRelative.startsWith("/"))) await assertRealpathWithin(this.path, sourceRelative);
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isFile()) throw new QaSkillsError("Artifact source must be a file", "INVALID_ARTIFACT");
    const source = await readFile(sourcePath, "utf8");
    const format = sourcePath.endsWith(".yaml") || sourcePath.endsWith(".yml") ? "yaml" : "json";
    const value = parseAuthoringDocument(source, format);
    if (!validateArtifact(input.type, value).valid) throw new QaSkillsError("Artifact does not match its contract", "INVALID_ARTIFACT");
    await this.assertArtifactBinding(input.type, value, input.relationships);
    return this.registerCanonicalArtifact(input.type, value, input.relationships, input.provenance ?? "agent-draft");
  }

  public async transition(status: RunStatus): Promise<void> {
    this.assertWritable();
    if (status !== "RUNNING" || this.metadata.status !== "CREATED") {
      throw new QaSkillsError(`Lifecycle transition ${this.metadata.status} -> ${status} is reserved for finalize`, "ILLEGAL_TRANSITION");
    }
    await this.transitionInternal(status);
  }

  public async validate(profile: ArtifactProfileName = this.mode): Promise<WorkspaceValidation> {
    this.assertOpen();
    const manifest = await this.readManifest();
    const diagnostics: WorkspaceDiagnostic[] = [];
    const profileResult = evaluateArtifactProfile(profile, ["run-metadata", ...manifest.artifacts.map((artifact) => artifact.type)]);
    diagnostics.push(...profileResult.diagnostics);
    for (const artifact of manifest.artifacts) {
      const absolutePath = await assertPathWithin(this.path, artifact.relativePath);
      try {
        const actual = await sha256(absolutePath);
        if (actual !== artifact.sha256) diagnostics.push({ code: "CHECKSUM_MISMATCH", message: `Checksum mismatch for ${artifact.relativePath}`, relativePath: artifact.relativePath });
      } catch (error: unknown) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") diagnostics.push({ code: "MISSING_FILE", message: `Missing registered file ${artifact.relativePath}`, relativePath: artifact.relativePath });
        else throw error;
      }
    }
    const registered = new Set(manifest.artifacts.map((artifact) => artifact.relativePath));
    for (const path of await filesUnder(this.path, join(this.path, "inputs"))) {
      const relativePath = relative(this.path, path);
      if (!registered.has(relativePath)) diagnostics.push({ code: "ORPHAN_FILE", message: `Unregistered file ${relativePath}`, relativePath });
    }
    return { valid: diagnostics.length === 0, diagnostics };
  }

  public async finalize(profile: ArtifactProfileName = this.mode): Promise<WorkspaceValidation> {
    this.assertWritable();
    assertArtifactProfileName(profile);
    if (this.metadata.status === "CREATED") await this.transitionInternal("RUNNING");
    if (this.metadata.status !== "RUNNING") throw new QaSkillsError(`Cannot finalize a ${this.metadata.status} workspace`, "ILLEGAL_TRANSITION");
    this.metadata = { ...this.metadata, finalizedProfile: { name: profile, version: artifactProfileVersion } };
    await this.writeMetadata();
    await this.transitionInternal("FINALIZING");
    const result = await this.validate(profile);
    await this.transitionInternal(result.valid ? "COMPLETED" : "COMPLETED_WITH_FAILURES");
    return result;
  }

  public async close(): Promise<void> {
    if (!this.closed) {
      await this.lock?.release();
      this.closed = true;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new QaSkillsError("Workspace is closed", "CLOSED_WORKSPACE");
  }

  private assertWritable(): void {
    this.assertOpen();
    if (terminalStatuses.has(this.metadata.status)) throw new QaSkillsError("Terminal workspace is immutable", "TERMINAL_WORKSPACE");
  }

  private async assertArtifactBinding(type: ArtifactType, value: unknown, relationships: string[]): Promise<void> {
    if (!isRecord(value)) throw new QaSkillsError("Artifact binding requires an object", "ARTIFACT_BINDING");
    if (Object.hasOwn(value, "runId") && value.runId !== this.runId) {
      throw new QaSkillsError("Artifact run ID does not match this workspace", "ARTIFACT_BINDING");
    }
    if (Object.hasOwn(value, "environmentProfileId") && value.environmentProfileId !== this.metadata.environmentProfileId) {
      throw new QaSkillsError("Artifact environment profile ID does not match this workspace", "ARTIFACT_BINDING");
    }
    const manifest = await this.readManifest();
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
  }

  private async transitionInternal(status: RunStatus): Promise<void> {
    if (!nextStatuses[this.metadata.status].includes(status)) {
      throw new QaSkillsError(`Illegal lifecycle transition: ${this.metadata.status} -> ${status}`, "ILLEGAL_TRANSITION");
    }
    this.metadata = { ...this.metadata, status };
    await this.writeMetadata();
    if (terminalStatuses.has(status)) await this.lock?.release();
  }

  private async registerCanonicalArtifact(type: ArtifactType, value: unknown, relationships: string[], provenance: string): Promise<ArtifactRecord & { absolutePath: string }> {
    const canonicalContents = `${JSON.stringify(value, null, 2)}\n`;
    const checksum = sha256Text(canonicalContents);
    const manifest = await this.readManifest();
    if (manifest.artifacts.some((artifact) => artifact.type === type && artifact.sha256 === checksum)) throw new QaSkillsError("Completed artifacts are immutable; duplicate artifact", "DUPLICATE_ARTIFACT");
    const id = createEntityId();
    const relativePath = `inputs/${id}-${type}.json`;
    const absolutePath = resolveWithin(this.path, relativePath);
    await atomicWriteFile(this.path, absolutePath, canonicalContents);
    const actualChecksum = await sha256(absolutePath);
    if (actualChecksum !== checksum) throw new QaSkillsError("Atomic artifact write checksum mismatch", "WRITE_FAILURE");
    const record: ArtifactRecord = { id, type, relativePath, sha256: checksum, provenance, relationships: [...relationships] };
    manifest.artifacts.push(record);
    await this.writeManifest(manifest);
    return { ...record, absolutePath };
  }

  private async readManifest(): Promise<Manifest> {
    const path = await assertRealpathWithin(this.path, "artifact-manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8")) as Manifest;
    if (!validateArtifact("artifact-manifest", manifest).valid) throw new QaSkillsError("Invalid artifact manifest", "INVALID_MANIFEST");
    return manifest;
  }

  private async writeMetadata(): Promise<void> {
    await atomicWriteFile(this.path, resolveWithin(this.path, "run-metadata.json"), `${JSON.stringify(this.metadata, null, 2)}\n`);
  }

  private async writeManifest(manifest: Manifest): Promise<void> {
    await atomicWriteFile(this.path, resolveWithin(this.path, "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
