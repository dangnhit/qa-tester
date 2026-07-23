import { readdir, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { manifestFilename } from "./manifest.js";
import { type VerifyOptions, verifySkills } from "./verify.js";

export type UninstallResult = Readonly<{ root: string; removed: readonly string[]; leftovers: readonly string[] }>;

async function removeEmptyParents(root: string, path: string): Promise<void> {
  let current = dirname(path);
  while (current.startsWith(root) && current !== root) {
    try {
      if ((await readdir(current)).length !== 0) return;
      await rm(current);
      current = dirname(current);
    } catch { return; }
  }
}

export async function uninstallSkills(options: VerifyOptions): Promise<UninstallResult> {
  const verification = await verifySkills(options);
  if (!verification.manifest) return { root: verification.root, removed: [], leftovers: [] };
  const removed: string[] = [];
  const leftovers = verification.entries.filter((entry) => entry.status !== "valid" && entry.status !== "missing").map((entry) => entry.path);
  for (const entry of verification.entries.filter((entry) => entry.status === "valid")) {
    await unlink(entry.path);
    removed.push(entry.path);
    await removeEmptyParents(verification.root, entry.path);
  }
  if (leftovers.length === 0) {
    try { await unlink(join(verification.root, manifestFilename)); removed.push(join(verification.root, manifestFilename)); } catch { /* Manifest is already absent. */ }
    await removeEmptyParents(dirname(verification.root), verification.root);
  }
  return { root: verification.root, removed, leftovers };
}
