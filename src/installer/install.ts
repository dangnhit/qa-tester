import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFile } from "../core/fs.js";
import { type AgentName, type InstallTarget, resolveAgentRoot } from "./agents.js";
import { createManifest, manifestFilename, runtimeVersion, serializeManifest, validateRelativeFilePath } from "./manifest.js";

export type InstallOptions = Readonly<{
  sourceRoot?: string;
  sourceVersion?: string;
  projectRoot: string;
  userHome?: string;
  agent: AgentName;
  target: InstallTarget;
}>;
export type InstallResult = Readonly<{ root: string; files: readonly string[] }>;

/** Locate the packaged bundle in either source or compiled package layouts. */
export function defaultBundleRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDirectory, moduleDirectory.includes(`${join("dist", "src", "installer")}`) ? "../../../skills" : "../../skills");
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

async function ensureSafeRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Skill target must be a real directory: ${root}`);
}

/** Copy a bundle with atomic files. The caller must preflight overwrite policy. */
export async function writeBundle(options: InstallOptions, root: string, overwrite: boolean): Promise<InstallResult> {
  const sourceRoot = resolve(options.sourceRoot ?? defaultBundleRoot());
  const manifest = await createManifest({ sourceRoot, agent: options.agent, target: options.target, sourceVersion: options.sourceVersion ?? runtimeVersion });
  const paths = manifest.files.map((file) => validateRelativeFilePath(file.path));
  await ensureSafeRoot(root);
  // Read all source bytes and inspect every target before writing anything.
  const contents = await Promise.all(paths.map(async (file) => ({ file, contents: await readFile(join(sourceRoot, file)) })));
  if (!overwrite) {
    for (const { file } of contents) if (await exists(join(root, file))) throw new Error(`Refusing to overwrite unmanaged skill file: ${join(root, file)}`);
    if (await exists(join(root, manifestFilename))) throw new Error(`QA skills are already installed at ${root}; use update instead`);
  }
  for (const item of contents) await atomicWriteFile(root, join(root, item.file), item.contents);
  await atomicWriteFile(root, join(root, manifestFilename), serializeManifest(manifest));
  return { root, files: paths.map((file) => join(root, file)) };
}

export async function installSkills(options: InstallOptions): Promise<InstallResult> {
  const root = resolveAgentRoot(options.agent, options.target, options);
  return writeBundle(options, root, false);
}
