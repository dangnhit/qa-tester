import { lstat, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { QaSkillsError } from "./errors.js";

/** The `node:path` members the platform-sensitive helpers below need. Injecting it lets a POSIX test
 *  pass `path.win32` and observe the Windows behaviour directly — the same seam `resolveAgentRoot`
 *  already uses for `pathApi`, so a Windows-only path bug cannot hide until CI is next looked at. */
export type PathSemantics = Readonly<{
  relative: (from: string, to: string) => string;
  isAbsolute: (path: string) => boolean;
  sep: string;
}>;
const nativePathSemantics: PathSemantics = { relative, isAbsolute, sep };

/** Whether an already-resolved absolute `candidate` is `root` itself or lies under it. Separator-aware
 *  in both directions: the escape marker is `..${sep}` — `..\` on Windows, where a check for `../`
 *  alone silently admits every traversal — and a candidate on another Windows drive relative-izes to
 *  an absolute path, which `isAbsolute` rejects.
 *
 *  Exported so that a decision of the form "does this resolved path lie under this root" shares this
 *  one implementation instead of re-deriving a POSIX-only one. Callers: `resolveWithin`,
 *  `assertPathWithin`, `assertRealpathWithin` and `isRealPathWithin` below; `test-data/hooks.ts`'s
 *  `contained`; and `run-workspace.ts`'s decision of whether a registration source is inside the
 *  workspace.
 *
 *  Three places make a related decision and deliberately do NOT call this, so the list above is not
 *  a claim that no other prefix test exists:
 *  - `installer/manifest.ts`'s `validateRelativeFilePath` is a syntax gate on a DECLARED manifest
 *    string, not a comparison of two filesystem paths. It rejects `\` outright and is already
 *    stricter than this on both platforms.
 *  - `installer/uninstall.ts` and `installer/shims.ts`'s `removeEmptyParents` loops guard an
 *    ancestor walk with a raw `current.startsWith(root)`. Both sides are native paths produced by
 *    `dirname`, so there is no separator hazard and no Windows defect. The raw prefix test does
 *    admit a sibling that merely shares a prefix (`/a/bc` under `/a/b`), which is pre-existing,
 *    needs a mis-scoped target to reach, and can only remove already-empty directories. Left
 *    untouched deliberately rather than overlooked. */
export function isPathWithin(root: string, candidate: string, pathApi: PathSemantics = nativePathSemantics): boolean {
  const relativePath = pathApi.relative(root, candidate);
  return relativePath === ""
    || (relativePath !== ".." && !relativePath.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relativePath));
}

/** A workspace manifest records every artifact at a canonical POSIX `relativePath`
 *  (`inputs/<id>-<type>.json`, `evidence/<id>-<name>.png`) on EVERY platform — that path is part of
 *  the portable, checksummed artifact contract, not a local filesystem detail. `path.relative`,
 *  however, yields `inputs\<id>-<type>.json` on Windows. Any path derived from the filesystem must
 *  therefore be converted here before it is compared against, or reported as, a manifest
 *  `relativePath`; otherwise every registered file reads as an unregistered orphan on Windows.
 *  Splitting on the platform `sep` rather than on `[\\/]` is deliberate: a backslash is a legal
 *  filename character on POSIX and must not be mistaken for a separator there. */
export function manifestRelativePath(root: string, absolutePath: string, pathApi: PathSemantics = nativePathSemantics): string {
  const nativeRelative = pathApi.relative(root, absolutePath);
  return pathApi.sep === "/" ? nativeRelative : nativeRelative.split(pathApi.sep).join("/");
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
  if (isPathWithin(resolvedRoot, resolvedCandidate)) return resolvedCandidate;
  throw new QaSkillsError(`Path traversal or escape is not allowed: ${candidate}`, "PATH_ESCAPE");
}

/**
 * True when `candidate` — or, when it does not exist yet, its nearest existing ancestor — REALLY lands
 * inside `root`, symlinks followed.
 *
 * The predicate half of `assertPathWithin`: same resolution, same `isPathWithin` comparison, no
 * refusal. It exists because those two answer opposite questions. `assertPathWithin` serves a caller
 * that must refuse a path for being OUTSIDE a root; this serves one that must refuse a path for being
 * INSIDE one (`export-projection.ts`, which will not write a derived file into a closed run workspace).
 * Inverting an assertion by catching its throw would make the common case — a path legitimately outside
 * — travel by exception, and would conflate `PATH_ESCAPE` with `SYMLINK_ESCAPE` as if both meant "fine".
 *
 * It shares `nearestExistingParent` rather than resolving the leaf itself, and that sharing is the
 * point: `lstat`ping the candidate BEFORE walking up is what makes a symlink AT THE LEAF resolve to its
 * target instead of being treated as a not-yet-existing file inside its (innocent) parent directory. A
 * hand-rolled `realpath(dirname(candidate))` misses exactly that case, and `fa6c60c` is this repo's
 * record of what a containment call site that re-derives the decision instead of delegating costs.
 *
 * A DANGLING symlink THROWS rather than answering: `lstat` sees the link, `realpath` cannot resolve its
 * missing target, and the `ENOENT` propagates. That is the safe direction — a caller refusing a path for
 * being inside a root gets a refusal either way, and never a `false` that would wave the write through
 * to a target the link would have created. It is shared with `assertPathWithin`, which behaves the same
 * way for the same reason, so the two do not disagree about what an unresolvable path means.
 */
export async function isRealPathWithin(root: string, candidate: string): Promise<boolean> {
  const existing = await nearestExistingParent(resolve(candidate));
  const [realRoot, realExisting] = await Promise.all([realpath(root), realpath(existing)]);
  return isPathWithin(realRoot, realExisting);
}

/** Ensures a target or its nearest existing parent does not escape through a symlink. */
export async function assertPathWithin(root: string, candidate: string): Promise<string> {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolveWithin(resolvedRoot, candidate);
  const [realRoot, existingParent] = await Promise.all([realpath(resolvedRoot), nearestExistingParent(resolvedCandidate)]);
  const realParent = await realpath(existingParent);
  if (isPathWithin(realRoot, realParent)) return resolvedCandidate;
  throw new QaSkillsError(`Symlink escape is not allowed: ${candidate}`, "SYMLINK_ESCAPE");
}

export async function assertRealpathWithin(root: string, candidate: string): Promise<string> {
  const resolved = await assertPathWithin(root, candidate);
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(resolved)]);
  if (isPathWithin(realRoot, realCandidate)) return realCandidate;
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
