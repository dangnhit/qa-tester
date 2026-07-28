import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { sha256Bytes, sha256Text } from "./checksum.js";
import { QaSkillsError } from "./errors.js";
import { assertRealpathWithin, resolveWithin } from "./fs.js";

const runFile = promisify(execFile);

/** Runs one `git` invocation and yields its stdout; rejects when git exits non-zero. */
export type GitExecutor = (args: readonly string[], cwd: string) => Promise<string>;

export type GitAnchorRequest = Readonly<{
  /** Directory the `git` invocations run from; the repository root is discovered from it. */
  projectRoot: string;
  /** The Reviewed Test Suite's directory, absolute or relative to `projectRoot`. */
  specDir: string;
  /** Test seam for failure modes a real repository cannot produce (git absent, git failing). */
  execute?: GitExecutor;
}>;

export type GitAnchor = Readonly<{ commitSha: string; specTreeSha256: string }>;

const commitShaPattern = /^[a-f0-9]{40}$/;

const defaultExecutor: GitExecutor = async (args, cwd) =>
  (await runFile("git", [...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;

function isSpawnFailure(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

async function runGit(execute: GitExecutor, args: readonly string[], cwd: string, code: string, message: string): Promise<string> {
  try {
    return await execute(args, cwd);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new QaSkillsError(`${message}: ${detail}`, isSpawnFailure(error) ? "GIT_UNAVAILABLE" : code);
  }
}

/** Resolves the spec directory against the project root with its ancestor symlinks already followed,
 *  so containment is judged on physical paths while a symlinked spec directory itself stays visible. */
async function resolveSpecDirCandidate(projectRoot: string, specDir: string): Promise<string> {
  const requested = resolve(projectRoot, specDir);
  const stats = await stat(requested).catch(() => undefined);
  if (!stats) throw new QaSkillsError(`Spec directory does not exist: ${requested}`, "SPEC_DIR_MISSING");
  if (!stats.isDirectory()) throw new QaSkillsError(`Spec directory is not a directory: ${requested}`, "SPEC_DIR_NOT_A_DIRECTORY");
  return join(await realpath(dirname(requested)), basename(requested));
}

/** The digest's canonical line for one tracked file: the path git emitted, NUL, the working-tree
 *  content hash, newline. Contents are hashed as raw bytes with no normalization at all. */
async function specTreeLine(repoRoot: string, gitPath: string): Promise<string> {
  const bytes = await readFile(resolveWithin(repoRoot, gitPath));
  return `${gitPath}\0${sha256Bytes(bytes)}\n`;
}

function byPathBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * Resolves the git anchor a **Runtime-Observed Execution** records: the commit a human accepted
 * (`commitSha`) and a checksum of the spec tree that actually ran (`specTreeSha256`). Both are
 * required by `test-result-batch` 3.0.0, and CONTEXT.md:344 makes a spec tree that differs from its
 * recorded commit unrunnable — so this refuses a dirty tree outright rather than downgrading. A
 * lowered provenance would still write a commit identity describing a tree that is not the tree
 * that ran, and the artifact carrying it is immutable.
 *
 * `specTreeSha256` is a normative on-disk contract value. Once a producer writes it into an
 * immutable artifact the algorithm can never change silently, so it is defined here verbatim:
 *
 * 1. Enumerate tracked files with `git ls-files -z --cached -- <specDir>` from the repository root.
 *    Tracked files only — untracked files are refused by the dirty check before this runs.
 * 2. For each path, read the bytes **from the working tree** and take their `sha256` hex.
 * 3. Canonical line per file: `<path>` + `"\0"` + `<sha256hex>` + `"\n"`, where `<path>` is the
 *    repo-root-relative POSIX path exactly as git emitted it. No absolute path ever enters the
 *    digest, so two clones of one commit at different locations agree.
 * 4. Sort the lines by path as raw UTF-8 bytes — never git's emission order, never a
 *    locale-sensitive comparison.
 * 5. The digest is `sha256` over `"qa-skills/spec-tree/v1\n"` followed by the joined lines. The
 *    version prefix exists so a future change to this rule produces a visibly different value
 *    instead of a silently incompatible one.
 *
 * File contents are never normalized: a CRLF/LF difference is visible rather than smoothed away.
 */
export async function resolveGitAnchor(request: GitAnchorRequest): Promise<GitAnchor> {
  const execute = request.execute ?? defaultExecutor;
  const specDirCandidate = await resolveSpecDirCandidate(request.projectRoot, request.specDir);
  const repoRoot = (await runGit(execute, ["rev-parse", "--show-toplevel"], request.projectRoot, "NOT_A_GIT_REPOSITORY", `No git repository contains ${request.projectRoot}`)).trim();
  const specDir = await assertRealpathWithin(repoRoot, specDirCandidate);
  const pathspec = relative(repoRoot, specDir).split(sep).join("/") || ".";

  const commitSha = (await runGit(execute, ["rev-parse", "HEAD"], repoRoot, "GIT_NO_COMMIT", `Repository ${repoRoot} has no commit at HEAD`)).trim();
  if (!commitShaPattern.test(commitSha)) throw new QaSkillsError(`git reported a HEAD commit that is not a 40-character hex SHA: ${commitSha}`, "GIT_COMMIT_SHA_INVALID");

  const status = await runGit(execute, ["status", "--porcelain", "--untracked-files=all", "--", pathspec], repoRoot, "GIT_STATUS_FAILED", `Unable to read the working-tree status of ${specDir}`);
  if (status.length > 0) throw new QaSkillsError(`Spec directory ${specDir} differs from ${commitSha}; commit or revert it before an observed execution:\n${status}`, "SPEC_TREE_DIRTY");

  const listed = await runGit(execute, ["ls-files", "-z", "--cached", "--", pathspec], repoRoot, "GIT_LS_FILES_FAILED", `Unable to list the tracked files under ${specDir}`);
  const paths = listed.split("\0").filter((entry) => entry.length > 0);
  if (paths.length === 0) throw new QaSkillsError(`Spec directory ${specDir} has no tracked files at ${commitSha}`, "SPEC_TREE_EMPTY");

  const lines = await Promise.all([...paths].sort(byPathBytes).map((path) => specTreeLine(repoRoot, path)));
  return { commitSha, specTreeSha256: sha256Text(`qa-skills/spec-tree/v1\n${lines.join("")}`) };
}
