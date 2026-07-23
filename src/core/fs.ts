import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { QaSkillsError } from "./errors.js";

export function resolveWithin(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(resolvedRoot, candidate);
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  if (relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !relativePath.startsWith(sep))) {
    return resolvedCandidate;
  }
  throw new QaSkillsError(`Path traversal or escape is not allowed: ${candidate}`, "PATH_ESCAPE");
}

export async function assertRealpathWithin(root: string, candidate: string): Promise<string> {
  const resolved = resolveWithin(root, candidate);
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(resolved)]);
  const relativePath = relative(realRoot, realCandidate);
  if (relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !relativePath.startsWith(sep))) {
    return realCandidate;
  }
  throw new QaSkillsError(`Symlink escape is not allowed: ${candidate}`, "SYMLINK_ESCAPE");
}

export async function atomicWriteFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}
