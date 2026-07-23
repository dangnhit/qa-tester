import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256Text } from "../core/checksum.js";
import { type AgentName, type InstallTarget, resolveAgentRoot } from "./agents.js";
import { manifestFilename, readManifest, type SkillManifest, validateRelativeFilePath } from "./manifest.js";

export type DriftStatus = "missing" | "modified" | "unexpected" | "valid";
export type VerificationEntry = Readonly<{ path: string; status: DriftStatus }>;
export type VerifyOptions = Readonly<{ sourceRoot?: string; projectRoot: string; userHome?: string; agent: AgentName; target: InstallTarget }>;
export type Verification = Readonly<{ root: string; manifest?: SkillManifest; status: DriftStatus; entries: readonly VerificationEntry[] }>;

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

export async function verifySkills(options: VerifyOptions): Promise<Verification> {
  const root = resolveAgentRoot(options.agent, options.target, options);
  const manifest = await readManifest(root);
  if (!manifest) return { root, status: "missing", entries: [{ path: join(root, manifestFilename), status: "missing" }] };
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
  return { root, manifest, status: overall(entries), entries };
}
