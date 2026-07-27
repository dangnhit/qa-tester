import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { sha256Text } from "../core/checksum.js";

export const manifestFilename = ".qa-skill-manifest.json";
export const runtimeVersion = "0.3.0";
export const runtimeCompatibility = ">=0.1.0 <1.0.0";

export type ManifestFile = Readonly<{ path: string; sha256: string }>;
/**
 * A per-agent discovery shim (ADR-0011). `path` is relative to the install root
 * (the project root or user home, not the copied-skills directory). `sha256` is
 * the checksum of the managed content: for a marker-delimited block it is the
 * block's inner text (the user owns the rest of that file); for a dedicated
 * file it is the whole file.
 */
export type ShimEntry = Readonly<{ path: string; sha256: string }>;
export type RuntimeBinding = Readonly<{
  command: string;
  resolvedPath: string;
  source: "project" | "path";
  version: string;
  sha256: string;
}>;
export type SkillManifest = Readonly<{
  manifestVersion: 1;
  sourceVersion: string;
  runtimeRange: string;
  agent: "codex" | "claude" | "cursor";
  target: "project" | "user";
  runtime: RuntimeBinding;
  files: readonly ManifestFile[];
  /**
   * Optional for backward compatibility: manifests written before ADR-0011 have
   * no `shims` key and are read as an empty list, so they still verify. New
   * installs always write this field (empty for Claude's native discovery).
   */
  shims?: readonly ShimEntry[];
}>;

export function validateRelativeFilePath(value: string): string {
  if (!value || value.startsWith("/") || value.startsWith("\\") || value.includes("\\") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe skill bundle path: ${value}`);
  }
  return value;
}

/** The MVP deliberately supports its published pre-1.0 runtime line only. */
export function isRuntimeCompatible(version: string, range = runtimeCompatibility): boolean {
  if (range !== runtimeCompatibility) return false;
  return /^0\.[1-9]\d*\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

async function listFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill bundle cannot contain symlinks: ${absolute}`);
    if (entry.isDirectory()) files.push(...await listFiles(root, absolute));
    else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join("/"));
  }
  return files;
}

export async function createManifest(options: Readonly<{ sourceRoot: string; agent: SkillManifest["agent"]; target: SkillManifest["target"]; runtime: RuntimeBinding; sourceVersion?: string }>): Promise<SkillManifest> {
  const sourceRoot = resolve(options.sourceRoot);
  const sourceVersion = options.sourceVersion ?? runtimeVersion;
  if (!isRuntimeCompatible(sourceVersion)) throw new Error(`Skill bundle requires ${runtimeCompatibility}; received runtime ${sourceVersion}`);
  const files = await listFiles(sourceRoot);
  return {
    manifestVersion: 1,
    sourceVersion,
    runtimeRange: runtimeCompatibility,
    agent: options.agent,
    target: options.target,
    runtime: options.runtime,
    files: await Promise.all(files.map(async (file) => ({ path: validateRelativeFilePath(file), sha256: sha256Text(await readFile(join(sourceRoot, file), "utf8")) }))),
  };
}

export async function readManifest(root: string): Promise<SkillManifest | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(root, manifestFilename), "utf8"));
    if (!isManifest(value)) throw new Error("Invalid QA skill manifest");
    return value;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function serializeManifest(manifest: SkillManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function isManifest(value: unknown): value is SkillManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const runtime = candidate.runtime;
  return candidate.manifestVersion === 1 && typeof candidate.sourceVersion === "string" && typeof candidate.runtimeRange === "string" && isRuntimeCompatible(candidate.sourceVersion, candidate.runtimeRange)
    && (candidate.agent === "codex" || candidate.agent === "claude" || candidate.agent === "cursor")
    && (candidate.target === "project" || candidate.target === "user")
    && runtime !== null && typeof runtime === "object"
    && typeof (runtime as Record<string, unknown>).command === "string"
    && typeof (runtime as Record<string, unknown>).resolvedPath === "string"
    && ((runtime as Record<string, unknown>).source === "project" || (runtime as Record<string, unknown>).source === "path")
    && typeof (runtime as Record<string, unknown>).version === "string"
    && isRuntimeCompatible(String((runtime as Record<string, unknown>).version), candidate.runtimeRange)
    && typeof (runtime as Record<string, unknown>).sha256 === "string"
    && /^[a-f0-9]{64}$/.test(String((runtime as Record<string, unknown>).sha256))
    && Array.isArray(candidate.files) && candidate.files.every(isManifestEntry)
    && (candidate.shims === undefined || (Array.isArray(candidate.shims) && candidate.shims.every(isManifestEntry)));
}

function isManifestEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  if (typeof record.path !== "string" || typeof record.sha256 !== "string") return false;
  try { validateRelativeFilePath(record.path); return true; } catch { return false; }
}

export async function isDirectory(path: string): Promise<boolean> {
  try { return (await lstat(path)).isDirectory(); } catch { return false; }
}
