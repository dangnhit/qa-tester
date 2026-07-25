import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { atomicWriteFile } from "../core/fs.js";
import { QaSkillsError } from "../core/errors.js";
import { resolveInstallRoot } from "./agents.js";
import { manifestFilename, validateRelativeFilePath } from "./manifest.js";
import { type InstallOptions, type InstallResult, writeBundle } from "./install.js";
import { verifySkills } from "./verify.js";

export type UpdateOptions = InstallOptions & Readonly<{ force?: boolean }>;
export type UpdateResult = InstallResult & Readonly<{ backupRoot?: string }>;

/**
 * Copy every file `writeBundle` may overwrite into a fresh backup dir before `--force` proceeds.
 * That is the tracked bundle files + the manifest (all relative to the skills `root`) AND the
 * install-root shim files (`AGENTS.md`, `.cursor/rules/qa-skills.mdc`) — which live outside the
 * atomically-swapped skills tree and would otherwise be refreshed with no backup at all.
 */
async function backupTrackedFiles(root: string, paths: readonly string[], installRoot: string, shimPaths: readonly string[]): Promise<string> {
  const backupRoot = join(dirname(root), `${root.split(/[\\/]/).at(-1)}.qa-skill-backup-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  await mkdir(backupRoot, { recursive: false });
  const backup = async (source: string, relative: string): Promise<void> => {
    try {
      await atomicWriteFile(backupRoot, join(backupRoot, relative), await readFile(source));
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  };
  for (const path of [...paths, join(root, manifestFilename)]) await backup(path, path.slice(root.length + 1));
  for (const shimPath of shimPaths) {
    const segments = validateRelativeFilePath(shimPath).split("/");
    await backup(join(installRoot, ...segments), join("shims", ...segments));
  }
  return backupRoot;
}

export async function updateSkills(options: UpdateOptions): Promise<UpdateResult> {
  const verification = await verifySkills(options);
  if (!verification.manifest) throw new QaSkillsError(`QA skills are not installed at ${verification.root}; use install first`, "INSTALLER_INPUT");
  if (verification.status !== "valid" && !options.force) throw new QaSkillsError(`Refusing update because installed skills have drift (${verification.status}). Verify or use --force to create a backup first.`, "INSTALLER_SAFETY");
  const installRoot = resolveInstallRoot(options.target, options);
  const shimPaths = (verification.manifest.shims ?? []).map((shim) => shim.path);
  const backupRoot = options.force
    ? await backupTrackedFiles(verification.root, verification.entries.map((entry) => entry.path), installRoot, shimPaths)
    : undefined;
  const result = await writeBundle(options, verification.root, true);
  return backupRoot === undefined ? result : { ...result, backupRoot };
}
