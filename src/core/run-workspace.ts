import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import type { ArtifactType, RunStatus } from "../contracts/types.js";
import { parseAuthoringDocument } from "../contracts/authoring.js";
import { validateArtifact } from "../contracts/validator.js";
import { QaSkillsError } from "./errors.js";
import { artifactProfileNames, evaluateArtifactProfile, type ArtifactProfileName } from "./artifact-profiles.js";
import { sha256 } from "./checksum.js";
import { assertRealpathWithin, atomicWriteFile, resolveWithin } from "./fs.js";
import { createEntityId, createRunId } from "./ids.js";
import { acquireRunLock, type RunLock } from "./run-lock.js";
import { utcNow } from "./time.js";

export type ArtifactRecord = {
  id: string;
  type: ArtifactType | "evidence-gap";
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
  CREATED: ["RUNNING", "ABORTED"],
  RUNNING: ["FINALIZING", "BLOCKED", "ABORTED"],
  FINALIZING: ["COMPLETED", "COMPLETED_WITH_FAILURES", "BLOCKED", "ABORTED"],
  COMPLETED: [],
  COMPLETED_WITH_FAILURES: [],
  BLOCKED: [],
  ABORTED: [],
};

function isArtifactType(value: string): value is ArtifactType {
  return ["run-metadata", "artifact-manifest", "environment-profile", "test-case", "test-step-result", "test-result", "evidence", "bug-report", "test-data-manifest", "qa-execution-report"].includes(value);
}

async function filesUnder(directory: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry);
    if ((await stat(path)).isDirectory()) return filesUnder(path);
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

  public static async create(options: { root: string; mode: ArtifactProfileName; environmentProfile: Record<string, unknown>; linkedRunId?: string }): Promise<RunWorkspace> {
    if (!(artifactProfileNames as readonly string[]).includes(options.mode)) throw new QaSkillsError("Invalid mode", "INVALID_MODE");
    if (!validateArtifact("environment-profile", options.environmentProfile).valid) throw new QaSkillsError("Invalid environment profile", "INVALID_ARTIFACT");
    const runId = createRunId();
    const path = resolve(options.root, "qa-results", runId);
    await mkdir(path, { recursive: true });
    const lock = await acquireRunLock(path);
    const profileId = options.environmentProfile.environmentProfileId;
    if (typeof profileId !== "string") throw new QaSkillsError("Environment profile ID is required", "INVALID_ARTIFACT");
    const metadata: WorkspaceMetadata = {
      artifactType: "run-metadata", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId,
      status: "CREATED", createdAt: utcNow(), mode: options.mode, environmentProfileId: profileId,
      ...(options.linkedRunId ? { linkedRunId: options.linkedRunId } : {}),
    };
    const workspace = new RunWorkspace(resolve(options.root), path, runId, options.mode, metadata, lock);
    await workspace.writeMetadata();
    await workspace.writeManifest({ artifactType: "artifact-manifest", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId, artifacts: [] });
    await atomicWriteFile(join(path, "environment-profile.json"), `${JSON.stringify(options.environmentProfile, null, 2)}\n`);
    return workspace;
  }

  public static async open(root: string, runId: string): Promise<RunWorkspace> {
    const path = resolveWithin(resolve(root), join("qa-results", runId));
    const metadata = JSON.parse(await readFile(join(path, "run-metadata.json"), "utf8")) as WorkspaceMetadata;
    if (!validateArtifact("run-metadata", metadata).valid) throw new QaSkillsError("Invalid workspace metadata", "INVALID_ARTIFACT");
    const lock = terminalStatuses.has(metadata.status) ? undefined : await acquireRunLock(path);
    return new RunWorkspace(resolve(root), path, runId, metadata.mode, metadata, lock);
  }

  public async resolve(relativePath: string): Promise<string> {
    return assertRealpathWithin(this.path, relativePath);
  }

  public async registerArtifact(input: { type: ArtifactType | "evidence-gap"; sourcePath: string; relationships: string[]; provenance?: string }): Promise<ArtifactRecord & { absolutePath: string }> {
    this.assertWritable();
    if (!isArtifactType(input.type) && input.type !== "evidence-gap") throw new QaSkillsError("Unsupported artifact type", "INVALID_ARTIFACT");
    const sourcePath = resolve(input.sourcePath);
    if (sourcePath.startsWith(`${this.path}/`)) await assertRealpathWithin(this.path, relative(this.path, sourcePath));
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isFile()) throw new QaSkillsError("Artifact source must be a file", "INVALID_ARTIFACT");
    let canonicalContents: string | undefined;
    if (input.type !== "evidence-gap") {
      const source = await readFile(sourcePath, "utf8");
      const format = sourcePath.endsWith(".yaml") || sourcePath.endsWith(".yml") ? "yaml" : "json";
      const value = parseAuthoringDocument(source, format);
      if (!validateArtifact(input.type, value).valid) throw new QaSkillsError("Artifact does not match its contract", "INVALID_ARTIFACT");
      canonicalContents = `${JSON.stringify(value, null, 2)}\n`;
    }
    const manifest = await this.readManifest();
    if (manifest.artifacts.some((artifact) => artifact.type === input.type)) throw new QaSkillsError("Completed artifacts are immutable; duplicate artifact type", "DUPLICATE_ARTIFACT");
    const id = createEntityId();
    const safeName = input.type === "evidence-gap" ? basename(sourcePath).replace(/[^A-Za-z0-9._-]/g, "_") : `${input.type}.json`;
    const relativePath = `inputs/${id}-${safeName}`;
    const absolutePath = resolveWithin(this.path, relativePath);
    await mkdir(join(this.path, "inputs"), { recursive: true });
    if (canonicalContents) await atomicWriteFile(absolutePath, canonicalContents);
    else await copyFile(sourcePath, absolutePath, 0);
    const record: ArtifactRecord = { id, type: input.type, relativePath, sha256: await sha256(absolutePath), provenance: input.provenance ?? "agent-draft", relationships: [...input.relationships] };
    manifest.artifacts.push(record);
    await this.writeManifest(manifest);
    return { ...record, absolutePath };
  }

  public async transition(status: RunStatus): Promise<void> {
    if (!nextStatuses[this.metadata.status].includes(status)) throw new QaSkillsError(`Illegal lifecycle transition: ${this.metadata.status} -> ${status}`, "ILLEGAL_TRANSITION");
    this.metadata = { ...this.metadata, status };
    await this.writeMetadata();
    if (terminalStatuses.has(status)) await this.lock?.release();
  }

  public async validate(profile: ArtifactProfileName = this.mode): Promise<WorkspaceValidation> {
    const manifest = await this.readManifest();
    const diagnostics: WorkspaceDiagnostic[] = [];
    const profileResult = evaluateArtifactProfile(profile, ["run-metadata", "environment-profile", ...manifest.artifacts.map((artifact) => artifact.type)]);
    diagnostics.push(...profileResult.diagnostics);
    for (const artifact of manifest.artifacts) {
      const absolutePath = resolveWithin(this.path, artifact.relativePath);
      try {
        const actual = await sha256(absolutePath);
        if (actual !== artifact.sha256) diagnostics.push({ code: "CHECKSUM_MISMATCH", message: `Checksum mismatch for ${artifact.relativePath}`, relativePath: artifact.relativePath });
      } catch (error: unknown) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") diagnostics.push({ code: "MISSING_FILE", message: `Missing registered file ${artifact.relativePath}`, relativePath: artifact.relativePath });
        else throw error;
      }
    }
    const registered = new Set(manifest.artifacts.map((artifact) => artifact.relativePath));
    for (const path of await filesUnder(join(this.path, "inputs"))) {
      const relativePath = relative(this.path, path);
      if (!registered.has(relativePath)) diagnostics.push({ code: "ORPHAN_FILE", message: `Unregistered file ${relativePath}`, relativePath });
    }
    return { valid: diagnostics.length === 0, diagnostics };
  }

  public async finalize(profile: ArtifactProfileName = this.mode): Promise<WorkspaceValidation> {
    await this.transition("RUNNING");
    await this.transition("FINALIZING");
    const result = await this.validate(profile);
    await this.transition(result.valid ? "COMPLETED" : "COMPLETED_WITH_FAILURES");
    return result;
  }

  public async close(): Promise<void> {
    await this.lock?.release();
  }

  private assertWritable(): void {
    if (terminalStatuses.has(this.metadata.status)) throw new QaSkillsError("Terminal workspace is immutable", "TERMINAL_WORKSPACE");
  }

  private async readManifest(): Promise<Manifest> {
    const manifest = JSON.parse(await readFile(join(this.path, "artifact-manifest.json"), "utf8")) as Manifest;
    if (!validateArtifact("artifact-manifest", manifest).valid) throw new QaSkillsError("Invalid artifact manifest", "INVALID_MANIFEST");
    return manifest;
  }

  private async writeMetadata(): Promise<void> {
    await atomicWriteFile(join(this.path, "run-metadata.json"), `${JSON.stringify(this.metadata, null, 2)}\n`);
  }

  private async writeManifest(manifest: Manifest): Promise<void> {
    await atomicWriteFile(join(this.path, "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
