import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { sha256Text } from "../core/checksum.js";

export const manifestFilename = ".qa-skill-manifest.json";
export const runtimeVersion = "1.0.0";
export const runtimeCompatibility = ">=1.0.0 <2.0.0";

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

/** This build supports only the 1.x runtime line it publishes. The `range !== runtimeCompatibility`
 *  guard below predates 1.0: `--range` therefore only ever accepts the one current literal. That is
 *  pre-existing behavior, not something the 1.0 contract freeze tightens further — loosening it now,
 *  right before locking down semver, would be the wrong moment. */
export function isRuntimeCompatible(version: string, range = runtimeCompatibility): boolean {
  if (range !== runtimeCompatibility) return false;
  return /^1\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

/** Full semver SHAPE, deliberately independent of `runtimeCompatibility`'s major lock above (I4):
 *  a manifest a pre-1.0 install wrote records `sourceVersion`/`runtime.version` as something like
 *  "0.3.0", a well-formed version of a DIFFERENT major, not a malformed one. Anchored at both ends,
 *  so `exec` only matches a value that is semver top-to-bottom -- "1.2" (no patch), "1.a.0"
 *  (non-numeric minor), and "1.0.0x" (trailing garbage) all fail to match and so cannot produce a
 *  major through `semverMajor` below, which reads that group. There is no separate "is this
 *  semver-shaped" predicate: one that reused this same pattern to answer only that question would
 *  be true on EXACTLY the inputs `semverMajor` already turns into a real major, making it provably
 *  redundant with the major-equality check `isManifest` performs below -- dead code no mutation of
 *  it could ever turn a test red on, which is itself the defect (I1, v1.0 contract freeze follow-up:
 *  an unkillable guard is not a guard). */
const semverShapePattern = /^(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** This project has only ever written a `runtimeRange` in this exact two-comparator shape (see
 *  `runtimeCompatibility` above and every superseded literal before it: `>=0.1.0 <1.0.0`,
 *  `>=1.0.0 <2.0.0`, ...). A range that does not parse this way is not a range to compare a major
 *  against -- `isManifest` treats it as disqualifying, the same as a missing field (I2, v1.0 contract
 *  freeze follow-up). */
const rangeLowerBoundPattern = /^>=(\d+)\.\d+\.\d+ <\d+\.\d+\.\d+$/;

/** The major version component of `value`, or `""` if `value` is not a string or is not shaped like
 *  semver at all (`exec` on a non-string coerces via `ToString`, so a number/`undefined`/object all
 *  land here too). `""` never equals a `rangeLowerBoundMajor` result -- that pattern's `(\d+)` group
 *  cannot capture zero digits -- so a shape failure and a major mismatch are rejected by the exact
 *  same comparison in `isManifest`, on purpose: two independent-looking guards that could never
 *  disagree are one guard, not two, and this keeps the code honest about that. */
function semverMajor(value: unknown): string {
  return typeof value === "string" ? (semverShapePattern.exec(value)?.[1] ?? "") : "";
}

/** The major version this manifest's own `runtimeRange` names -- its lower bound's major, e.g. "0"
 *  for `>=0.1.0 <1.0.0"` or "1" for `>=1.0.0 <2.0.0`. `undefined` for anything that does not parse
 *  as a range in this project's shape (I2). */
function rangeLowerBoundMajor(range: string): string | undefined {
  return rangeLowerBoundPattern.exec(range)?.[1];
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
  // I2: dropping the 1.x-only lock (I4) must not also drop internal consistency. A manifest's
  // `sourceVersion` and `runtime.version` are required to share the SAME major as its own
  // `runtimeRange` names -- not any major this build happens to support. That is what makes a 0.x
  // manifest (range, sourceVersion, and runtime.version all "0") a well-formed manifest of a
  // different major, while a manifest claiming range `>=1.0.0 <2.0.0` but `sourceVersion: "0.0.1"`
  // (self-contradictory) still fails the same way it did before I4.
  //
  // `runtimeRangeMajor` is `string | undefined` and NOT re-checked against `undefined` below: the
  // two `semverMajor(...) === runtimeRangeMajor` comparisons already reject that case on their own,
  // because `semverMajor` never returns `undefined` (it falls back to `""`, see its own comment), so
  // a `string === undefined` comparison is always `false`. An explicit `runtimeRangeMajor !==
  // undefined` clause here would be the exact same dead-guard mistake `semverMajor`'s comment
  // documents for `isSemverLike` -- checked and confirmed by mutation before this comment was
  // written (removing it turns zero tests red).
  const runtimeRangeMajor = typeof candidate.runtimeRange === "string" ? rangeLowerBoundMajor(candidate.runtimeRange) : undefined;
  return candidate.manifestVersion === 1
    && semverMajor(candidate.sourceVersion) === runtimeRangeMajor
    && (candidate.agent === "codex" || candidate.agent === "claude" || candidate.agent === "cursor")
    && (candidate.target === "project" || candidate.target === "user")
    && runtime !== null && typeof runtime === "object"
    && typeof (runtime as Record<string, unknown>).command === "string"
    && typeof (runtime as Record<string, unknown>).resolvedPath === "string"
    && ((runtime as Record<string, unknown>).source === "project" || (runtime as Record<string, unknown>).source === "path")
    && semverMajor((runtime as Record<string, unknown>).version) === runtimeRangeMajor
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
