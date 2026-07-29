import { cp, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFile } from "../core/fs.js";
import { QaSkillsError } from "../core/errors.js";
import { sha256Bytes } from "../core/checksum.js";
import { captureRuntimeBinding, resolveCompatibleRuntime, type AgentName, type InstallTarget, resolveAgentRoot, resolveInstallRoot } from "./agents.js";
import { createManifest, manifestFilename, runtimeVersion, serializeManifest, validateRelativeFilePath } from "./manifest.js";
import { assertShimWritable, buildShims, deriveSkillNames, writeShims } from "./shims.js";

export type FailurePhase = "stage:first" | "write:middle" | "write:final" | "swap";
export type InstallOptions = Readonly<{
  sourceRoot?: string; sourceVersion?: string; projectRoot: string; userHome?: string; agent: AgentName; target: InstallTarget;
  /** Test-only deterministic fault seam; production callers do not supply it. */
  failureInjector?: (phase: FailurePhase) => void | Promise<void>;
}>;
export type InstallResult = Readonly<{ root: string; files: readonly string[]; runtime: Readonly<{ command: string; version: string }> }>;

export function defaultBundleRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDirectory, moduleDirectory.includes(`${join("dist", "src", "installer")}`) ? "../../../skills" : "../../skills");
}

async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch { return false; } }
async function inject(options: InstallOptions, phase: FailurePhase): Promise<void> { await options.failureInjector?.(phase); }

async function assertNoSymlinksTree(root: string): Promise<void> {
  if (!(await exists(root))) return;
  const stat = await lstat(root);
  if (stat.isSymbolicLink()) throw new QaSkillsError(`Skill install path contains a symlink: ${root}`, "INSTALLER_SAFETY");
  if (!stat.isDirectory()) throw new QaSkillsError(`Skill install path is not a directory: ${root}`, "INSTALLER_SAFETY");
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory() || entry.isSymbolicLink()) await assertNoSymlinksTree(join(root, entry.name));
}

/** Inspect only path components leading to a target, never unrelated project contents. */
async function assertTargetComponents(path: string): Promise<void> {
  let current = resolve(path);
  for (let depth = 0; depth < 3; depth += 1) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new QaSkillsError(`Skill install path contains a symlink: ${current}`, "INSTALLER_SAFETY"); } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}

type SyncHandle = Pick<Awaited<ReturnType<typeof open>>, "sync" | "close">;
export type DirectorySyncOptions = Readonly<{
  platform?: NodeJS.Platform;
  openDirectory?: (path: string) => Promise<SyncHandle>;
  /** Test seam mirroring `openDirectory`; production callers use the real handle. */
  openFile?: (path: string, flags: string) => Promise<SyncHandle>;
}>;

/** Errors Windows raises when it cannot service a flush — for the OPEN as well as for the `sync()`,
 *  since `syncTolerantly` wraps both. On Windows that means an anti-virus or indexer holding a staged
 *  file (`EPERM`/`EACCES` on open) is tolerated too, not only a handle NTFS declines to flush.
 *  Durability is deliberately best-effort there: refusing to install because a scanner briefly held a
 *  file we have already written and checksummed is worse than the weaker guarantee. Nothing is
 *  tolerated off Windows. */
const windowsUnsupportedSync = ["EISDIR", "EINVAL", "EPERM", "ENOTSUP", "EACCES"];

/** Open failures that mean "you may not write this file", and so justify retrying read-only. Anything
 *  else — ENOENT, EMFILE, EIO — is a real fault and must propagate rather than be reinterpreted as a
 *  read-only file. */
const notWritableOnOpen = ["EACCES", "EPERM", "EROFS", "ETXTBSY"];

function errorCode(error: unknown): string {
  return String(error instanceof Error && "code" in error ? error.code : undefined);
}

/** Flush one already-opened handle, tolerating the unsupported-flush errors above on Windows only. */
async function syncTolerantly(openHandle: () => Promise<SyncHandle>, platform: NodeJS.Platform): Promise<void> {
  try {
    const handle = await openHandle();
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error: unknown) {
    if (platform !== "win32" || !windowsUnsupportedSync.includes(errorCode(error))) throw error;
  }
}

export async function fsyncTree(root: string, options: DirectorySyncOptions = {}): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const platform = options.platform ?? process.platform;
  const openFile = options.openFile ?? ((path: string, flags: string) => open(path, flags));
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const item = join(root, entry.name);
    if (entry.isDirectory()) await fsyncTree(item, options);
    // Windows' FlushFileBuffers needs a handle with write access, so `open(item, "r")` + `sync()`
    // fails EPERM for every file — which made `fsyncTree(stage)` throw on every Windows install, not
    // just in tests. Staged files are ours and writable, so "r+" is the normal path; a genuinely
    // read-only file still falls back to the read handle exactly as before.
    else if (entry.isFile()) {
      await syncTolerantly(async () => {
        try {
          return await openFile(item, "r+");
        } catch (error: unknown) {
          if (!notWritableOnOpen.includes(errorCode(error))) throw error;
          return await openFile(item, "r");
        }
      }, platform);
    }
  }
  await syncTolerantly(() => (options.openDirectory ?? ((path: string) => open(path, "r")))(root), platform);
}

async function restore(root: string, previous: string | undefined, stage: string): Promise<void> {
  try { if (await exists(root)) await rm(root, { recursive: true, force: true }); } catch { /* Preserve original error. */ }
  try { if (previous && await exists(previous)) await rename(previous, root); } catch { /* Preserve original error. */ }
  try { if (await exists(stage)) await rm(stage, { recursive: true, force: true }); } catch { /* Preserve original error. */ }
}

/** Stage an entire target tree and atomically swap it, preserving unrelated files in the skill root. */
export async function writeBundle(options: InstallOptions, root: string, overwrite: boolean): Promise<InstallResult> {
  let runtime: Awaited<ReturnType<typeof resolveCompatibleRuntime>>;
  try { runtime = await resolveCompatibleRuntime(options.projectRoot); } catch (error: unknown) { throw new QaSkillsError(error instanceof Error ? error.message : "Local qa-skill setup failed", "INSTALLER_INPUT"); }
  const sourceRoot = resolve(options.sourceRoot ?? defaultBundleRoot());
  await assertNoSymlinksTree(sourceRoot); await assertTargetComponents(root); await assertNoSymlinksTree(root);
  const runtimeBinding = await captureRuntimeBinding(runtime);
  const baseManifest = await createManifest({ sourceRoot, agent: options.agent, target: options.target, runtime: runtimeBinding, sourceVersion: options.sourceVersion ?? runtimeVersion });
  const shimArtifacts = buildShims(options.agent, deriveSkillNames(baseManifest.files.map((file) => file.path)));
  const manifest = { ...baseManifest, shims: shimArtifacts.map((artifact) => artifact.entry) };
  const paths = manifest.files.map((file) => validateRelativeFilePath(file.path));
  const contents = await Promise.all(paths.map(async (file) => ({ file, contents: await readFile(join(sourceRoot, file)) })));
  if (!overwrite) {
    for (const { file } of contents) if (await exists(join(root, file))) throw new QaSkillsError(`Refusing to overwrite unmanaged skill file: ${join(root, file)}`, "INSTALLER_SAFETY");
    if (await exists(join(root, manifestFilename))) throw new QaSkillsError(`QA skills are already installed at ${root}; use update instead`, "INSTALLER_SAFETY");
  }
  const parent = dirname(root); await mkdir(parent, { recursive: true }); await assertTargetComponents(root);
  // Fail-fast: validate the install-root shims (which live OUTSIDE the atomically-swapped skills tree)
  // BEFORE any destructive move. Malformed AGENTS.md markers throw here with nothing touched, so a
  // marker fault can never leave a committed-then-rolled-back — and thus destroyed — bundle.
  const installRoot = resolveInstallRoot(options.target, options);
  await assertShimWritable(installRoot, shimArtifacts);
  const stamp = `${process.pid}-${crypto.randomUUID()}`; const stage = join(parent, `.${root.split(/[\\/]/).at(-1)}.qa-skill-stage-${stamp}`); const previous = join(parent, `.${root.split(/[\\/]/).at(-1)}.qa-skill-swap-${stamp}`);
  let originalMoved = false;
  let committed = false;
  try {
    if (await exists(root)) await cp(root, stage, { recursive: true, dereference: false, errorOnExist: true }); else await mkdir(stage, { recursive: true });
    await assertNoSymlinksTree(stage);
    await inject(options, "stage:first");
    for (const [index, item] of contents.entries()) {
      if (index === Math.floor(contents.length / 2)) await inject(options, "write:middle");
      await atomicWriteFile(stage, join(stage, item.file), item.contents);
    }
    await inject(options, "write:final");
    await atomicWriteFile(stage, join(stage, manifestFilename), serializeManifest(manifest));
    for (const file of manifest.files) {
      const bytes = await readFile(join(stage, file.path));
      if (sha256Bytes(bytes) !== file.sha256) throw new QaSkillsError(`Staged skill checksum mismatch: ${file.path}`, "INSTALLER_SAFETY");
    }
    await fsyncTree(stage);
    await inject(options, "swap");
    if (await exists(root)) { await rename(root, previous); originalMoved = true; }
    try { await rename(stage, root); } catch (error) { if (await exists(previous)) await rename(previous, root); originalMoved = false; throw error; }
    if (await exists(previous)) await rm(previous, { recursive: true, force: true });
    // The atomic swap has COMMITTED: `root` now holds the new bundle + manifest and the old bundle is
    // gone. Any later failure must NOT roll back — restore() would delete the just-installed bundle.
    // Clearing the rollback intent degrades a shim/marker write failure to the safe half-install path.
    committed = true;
    // Shims live at the install root (outside the atomically-swapped skills tree); write them
    // last so a failure leaves the bundle installed and `verify` flags the missing shim.
    await writeShims(installRoot, shimArtifacts);
    return { root, files: paths.map((file) => join(root, file)), runtime: { command: runtimeBinding.command, version: runtimeBinding.version } };
  } catch (error) {
    if (originalMoved && !committed) await restore(root, previous, stage); else if (await exists(stage)) await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function installSkills(options: InstallOptions): Promise<InstallResult> { return writeBundle(options, resolveAgentRoot(options.agent, options.target, options), false); }
