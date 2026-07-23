import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { atomicWriteFile } from "../core/fs.js";
import { QaSkillsError } from "../core/errors.js";
import { manifestFilename } from "./manifest.js";
import { type InstallOptions, type InstallResult, writeBundle } from "./install.js";
import { verifySkills } from "./verify.js";

export type UpdateOptions = InstallOptions & Readonly<{ force?: boolean }>;
export type UpdateResult = InstallResult & Readonly<{ backupRoot?: string }>;

async function backupTrackedFiles(root: string, paths: readonly string[]): Promise<string> {
  const backupRoot = join(dirname(root), `${root.split(/[\\/]/).at(-1)}.qa-skill-backup-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  await mkdir(backupRoot, { recursive: false });
  for (const path of [...paths, join(root, manifestFilename)]) {
    try {
      const relative = path.slice(root.length + 1);
      await atomicWriteFile(backupRoot, join(backupRoot, relative), await readFile(path));
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return backupRoot;
}

export async function updateSkills(options: UpdateOptions): Promise<UpdateResult> {
  const verification = await verifySkills(options);
  if (!verification.manifest) throw new QaSkillsError(`QA skills are not installed at ${verification.root}; use install first`, "INSTALLER_INPUT");
  if (verification.status !== "valid" && !options.force) throw new QaSkillsError(`Refusing update because installed skills have drift (${verification.status}). Verify or use --force to create a backup first.`, "INSTALLER_SAFETY");
  const backupRoot = options.force ? await backupTrackedFiles(verification.root, verification.entries.map((entry) => entry.path)) : undefined;
  const result = await writeBundle(options, verification.root, true);
  return backupRoot === undefined ? result : { ...result, backupRoot };
}
