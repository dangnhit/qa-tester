import { readdir, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveInstallRoot } from "./agents.js";
import { manifestFilename } from "./manifest.js";
import { removeShim } from "./shims.js";
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
  const manifest = verification.manifest;
  if (!manifest) return { root: verification.root, removed: [], leftovers: [] };
  const removed: string[] = [];
  const leftovers = [...verification.entries, ...verification.shims].filter((entry) => entry.status !== "valid" && entry.status !== "missing").map((entry) => entry.path);
  for (const entry of verification.entries.filter((entry) => entry.status === "valid")) {
    await unlink(entry.path);
    removed.push(entry.path);
    await removeEmptyParents(verification.root, entry.path);
  }
  // Shims are recorded relative to the install root; remove only clean ones and, for the Codex
  // AGENTS.md block, strip just the managed block so surrounding user content survives.
  const installRoot = resolveInstallRoot(options.target, options);
  const recordedShims = manifest.shims ?? [];
  for (const [index, shim] of verification.shims.entries()) {
    const recorded = recordedShims[index];
    if (shim.status !== "valid" || !recorded) continue;
    await removeShim(installRoot, recorded);
    removed.push(shim.path);
  }
  if (leftovers.length === 0) {
    try { await unlink(join(verification.root, manifestFilename)); removed.push(join(verification.root, manifestFilename)); } catch { /* Manifest is already absent. */ }
    await removeEmptyParents(dirname(verification.root), verification.root);
  }
  return { root: verification.root, removed, leftovers };
}
