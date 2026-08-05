import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256Text } from "../core/checksum.js";
import { captureRuntimeBinding, resolveCompatibleRuntime, type AgentName, type InstallTarget, resolveAgentRoot, resolveInstallRoot } from "./agents.js";
import { manifestFilename, readManifest, runtimeCompatibility, type RuntimeBinding, type SkillManifest, validateRelativeFilePath } from "./manifest.js";
import { readShimManagedContent } from "./shims.js";

export type DriftStatus = "missing" | "modified" | "unexpected" | "runtime-missing" | "runtime-changed" | "runtime-incompatible" | "valid";
export type VerificationEntry = Readonly<{ path: string; status: DriftStatus }>;
export type VerifyOptions = Readonly<{ sourceRoot?: string; projectRoot: string; userHome?: string; agent: AgentName; target: InstallTarget }>;
export type RuntimeVerification = Readonly<{ status: "valid" | "runtime-missing" | "runtime-changed" | "runtime-incompatible"; expected: RuntimeBinding; actual?: RuntimeBinding; reason?: string }>;
export type Verification = Readonly<{ root: string; manifest?: SkillManifest; runtime?: RuntimeVerification; status: DriftStatus; entries: readonly VerificationEntry[]; shims: readonly VerificationEntry[] }>;

async function filesBelow(root: string, current = root): Promise<string[]> {
  try {
    const entries = await readdir(current, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name === manifestFilename) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) files.push(...await filesBelow(root, absolute));
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(absolute);
    }
    return files;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ENOENT") return [];
      // A managed top-level entry is not necessarily a directory: the bundle root holds
      // `NOTICE.md` beside the per-skill directories, and the caller walks each top-level name
      // without first stat-ing it. `readdir` answers ENOTDIR for a file, and the file IS the whole
      // subtree, so yield it rather than throwing. Before this branch existed, any file at the
      // bundle root made `skills verify` exit 5 (ABORTED_OR_INTERNAL) with a raw ENOTDIR instead
      // of reporting drift — an internal failure where the answer was simply "nothing unexpected".
      if (error.code === "ENOTDIR") return current === root ? [] : [current];
    }
    throw error;
  }
}

function overall(entries: readonly VerificationEntry[]): DriftStatus {
  if (entries.some((entry) => entry.status === "missing")) return "missing";
  if (entries.some((entry) => entry.status === "modified")) return "modified";
  if (entries.some((entry) => entry.status === "unexpected")) return "unexpected";
  return "valid";
}

async function verifyRuntimeBinding(manifest: SkillManifest, projectRoot: string): Promise<RuntimeVerification> {
  // A manifest whose OWN recorded `runtimeRange` differs from what this build verifies is not
  // corrupt -- it is a well-formed manifest of a different major (I4, v1.0 contract freeze; every
  // 0.x install wrote ">=0.1.0 <1.0.0" here). This guard is symmetric, not "old vs. new": a manifest
  // recording a range this build does not YET know about (a future major) hits the exact same
  // branch, so `reason` below states facts only -- which range the manifest names, which range this
  // build verifies -- and never a directional word like "predates" or "older" that would be false
  // for the future-range case. Reusing `runtime-incompatible` rather than adding a new `DriftStatus`
  // value keeps the CLI's typed status set frozen at 1.0.
  //
  // The remedy named in `reason` is limited to the one command actually exercised end-to-end
  // (tests/installer/legacy-manifest.test.ts): "skills update --force" rewrites the manifest onto
  // `runtimeCompatibility`, the range of the binary CURRENTLY RUNNING the CLI -- which is a downgrade,
  // not a repair, when that binary is older than the one that wrote the manifest, so `reason` says so.
  // "skills install" is deliberately NOT suggested: it calls `writeBundle` with `overwrite: false`,
  // which throws `INSTALLER_SAFETY: Refusing to overwrite unmanaged skill file` the moment any file
  // from a previous install already exists at the target path -- it cannot recover this manifest.
  //
  // Checked before touching the live runtime at all: a mismatched recorded range disqualifies the
  // binding regardless of which binary happens to be resolvable on PATH right now.
  if (manifest.runtimeRange !== runtimeCompatibility) {
    return {
      status: "runtime-incompatible",
      expected: manifest.runtime,
      reason: `Installed skill manifest records runtime range ${manifest.runtimeRange}; this build verifies ${runtimeCompatibility}. Run "skills update --force" to rewrite the manifest onto the range this build verifies -- that moves the install to whichever range the binary currently running this CLI supports, which is a downgrade rather than a repair if this binary is older than the one that wrote the manifest. "skills install" does not help here: it refuses to overwrite files an existing install already wrote.`,
    };
  }
  try {
    await lstat(manifest.runtime.command);
  } catch {
    return { status: "runtime-missing", expected: manifest.runtime, reason: `Recorded runtime is missing: ${manifest.runtime.command}` };
  }
  let actual: RuntimeBinding;
  try {
    actual = await captureRuntimeBinding(await resolveCompatibleRuntime(projectRoot));
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "Runtime resolution failed";
    return { status: /incompatible/i.test(reason) ? "runtime-incompatible" : "runtime-missing", expected: manifest.runtime, reason };
  }
  if (actual.command !== manifest.runtime.command || actual.resolvedPath !== manifest.runtime.resolvedPath
    || actual.source !== manifest.runtime.source || actual.version !== manifest.runtime.version || actual.sha256 !== manifest.runtime.sha256) {
    return { status: "runtime-changed", expected: manifest.runtime, actual, reason: "Resolved runtime identity no longer matches the installed binding" };
  }
  return { status: "valid", expected: manifest.runtime, actual };
}

export async function verifySkills(options: VerifyOptions): Promise<Verification> {
  const root = resolveAgentRoot(options.agent, options.target, options);
  const manifest = await readManifest(root);
  if (!manifest) return { root, status: "missing", entries: [{ path: join(root, manifestFilename), status: "missing" }], shims: [] };
  const runtime = await verifyRuntimeBinding(manifest, options.projectRoot);
  const entries: VerificationEntry[] = [];
  const expected = new Set(manifest.files.map((file) => file.path));
  for (const file of manifest.files) {
    const relativePath = validateRelativeFilePath(file.path);
    const absolute = join(root, relativePath);
    try {
      const stat = await lstat(absolute);
      if (!stat.isFile()) entries.push({ path: absolute, status: "modified" });
      else entries.push({ path: absolute, status: sha256Text(await readFile(absolute, "utf8")) === file.sha256 ? "valid" : "modified" });
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") entries.push({ path: absolute, status: "missing" });
      else throw error;
    }
  }
  const managedTopLevels = new Set(manifest.files.map((file) => file.path.split("/")[0]).filter((part): part is string => part !== undefined));
  for (const topLevel of managedTopLevels) {
    for (const absolute of await filesBelow(root, join(root, topLevel))) {
      const relativePath = absolute.slice(root.length + 1).replaceAll("\\", "/");
      if (!expected.has(relativePath)) entries.push({ path: absolute, status: "unexpected" });
    }
  }
  const installRoot = resolveInstallRoot(options.target, options);
  const shims: VerificationEntry[] = [];
  for (const shim of manifest.shims ?? []) {
    const absolute = join(installRoot, ...validateRelativeFilePath(shim.path).split("/"));
    const managed = await readShimManagedContent(installRoot, shim);
    if (managed === undefined) shims.push({ path: absolute, status: "missing" });
    else shims.push({ path: absolute, status: sha256Text(managed) === shim.sha256 ? "valid" : "modified" });
  }
  const status = runtime.status === "valid" ? overall([...entries, ...shims]) : runtime.status;
  return { root, manifest, runtime, status, entries, shims };
}
