import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256Text } from "../core/checksum.js";
import { captureRuntimeBinding, resolveCompatibleRuntime, type AgentName, type InstallTarget, resolveAgentRoot, resolveInstallRoot } from "./agents.js";
import { manifestFilename, readManifest, type RuntimeBinding, type SkillManifest, validateRelativeFilePath } from "./manifest.js";
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
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
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
