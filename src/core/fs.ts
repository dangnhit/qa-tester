import { lstat, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { QaSkillsError } from "./errors.js";

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !relativePath.startsWith(sep));
}

async function nearestExistingParent(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export function resolveWithin(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(resolvedRoot, candidate);
  if (isWithin(resolvedRoot, resolvedCandidate)) return resolvedCandidate;
  throw new QaSkillsError(`Path traversal or escape is not allowed: ${candidate}`, "PATH_ESCAPE");
}

/** Ensures a target or its nearest existing parent does not escape through a symlink. */
export async function assertPathWithin(root: string, candidate: string): Promise<string> {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolveWithin(resolvedRoot, candidate);
  const [realRoot, existingParent] = await Promise.all([realpath(resolvedRoot), nearestExistingParent(resolvedCandidate)]);
  const realParent = await realpath(existingParent);
  if (isWithin(realRoot, realParent)) return resolvedCandidate;
  throw new QaSkillsError(`Symlink escape is not allowed: ${candidate}`, "SYMLINK_ESCAPE");
}

export async function assertRealpathWithin(root: string, candidate: string): Promise<string> {
  const resolved = await assertPathWithin(root, candidate);
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(resolved)]);
  if (isWithin(realRoot, realCandidate)) return realCandidate;
  throw new QaSkillsError(`Symlink escape is not allowed: ${candidate}`, "SYMLINK_ESCAPE");
}

export async function atomicWriteFile(root: string, path: string, contents: string | Uint8Array): Promise<void> {
  await assertPathWithin(root, path);
  await mkdir(dirname(path), { recursive: true });
  await assertPathWithin(root, path);
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, contents, { ...(typeof contents === "string" ? { encoding: "utf8" } : {}), mode: 0o600 });
  await rename(temporary, path);
}
