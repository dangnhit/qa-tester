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
/** `<tag> <mode> <object> <stage>\t<path>` — the record `git ls-files -s -v -z` emits. */
const trackedEntryPattern = /^(\S) (\d{6}) [^ ]+ \d+\t([^]*)$/;
/** The only `ls-files -v` tag a spec file may carry: cached, with no index bit set. Lowercase tags
 *  mark `--assume-unchanged`; `S` marks `--skip-worktree`. Both hide working-tree edits from
 *  `git status`, and `-t` cannot see the first of them — only `-v` reports the lowercase form. */
const cachedTag = "H";
/** Regular file and executable regular file. Every other git mode is refused, never skipped. */
const regularFileModes: ReadonlySet<string> = new Set(["100644", "100755"]);

type TrackedEntry = Readonly<{ tag: string; mode: string; path: string }>;

const defaultExecutor: GitExecutor = async (args, cwd) =>
  (await runFile("git", [...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;

function isSpawnFailure(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runGit(execute: GitExecutor, args: readonly string[], cwd: string, code: string, message: string): Promise<string> {
  try {
    return await execute(args, cwd);
  } catch (error: unknown) {
    throw new QaSkillsError(`${message}: ${describeFailure(error)}`, isSpawnFailure(error) ? "GIT_UNAVAILABLE" : code);
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

/** Parses one `ls-files -s -v -z` record. Fail closed: a record this pattern cannot read is a
 *  refusal, because the alternative is anchoring a tree we cannot fully describe. */
function parseTrackedEntry(record: string, specDir: string): TrackedEntry {
  const parsed = trackedEntryPattern.exec(record);
  const tag = parsed?.[1];
  const mode = parsed?.[2];
  const path = parsed?.[3];
  if (tag === undefined || mode === undefined || path === undefined) {
    throw new QaSkillsError(`Spec directory ${specDir} has a tracked entry this module cannot classify: ${JSON.stringify(record)}`, "SPEC_TREE_UNSUPPORTED_ENTRY");
  }
  return { tag, mode, path };
}

/** The digest's canonical line for one tracked file: the path git emitted, NUL, the working-tree
 *  content hash, newline. Contents are hashed as raw bytes with no normalization at all. */
async function specTreeLine(repoRoot: string, path: string): Promise<string> {
  const bytes = await readFile(resolveWithin(repoRoot, path));
  return `${path}\0${sha256Bytes(bytes)}\n`;
}

function byPathBytes(left: TrackedEntry, right: TrackedEntry): number {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
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
 * 1. Enumerate tracked entries with `git ls-files -s -v -z --cached -- :(literal)<specDir>` from the
 *    repository root. Tracked entries only; untracked and gitignored files are refused by the dirty
 *    check before this runs. An entry qualifies only if it satisfies **both** conditions:
 *
 *    - It is a **regular file** — git mode `100644` or `100755`. A symlink (`120000`) or a submodule
 *      gitlink (`160000`) is a refusal, never a skip: skipping one would leave content inside the
 *      spec tree that the digest does not cover, and following a symlink out of the repository would
 *      fold content reachable from no commit into a value that must be reproducible from the commit
 *      alone.
 *    - It carries **no index bit** — its `ls-files -v` tag is `H`. `S` (`--skip-worktree`) and any
 *      lowercase tag (`--assume-unchanged`) make `git status` suppress the entry, so a modified spec
 *      would clear the dirty check while step 2 still read its modified bytes into the digest. That
 *      is the same failure as an unreviewed edit earning coverage credit, reached through the index
 *      rather than through `.gitignore`. Refused, never cleared: this module does not mutate the
 *      caller's repository state. `-t` is not a substitute for `-v` — it reports an
 *      assume-unchanged entry as plain `H`.
 *
 *    A record that does not parse is refused too.
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
 * Two encoding details a reimplementation must match: every hex digest is **lowercase**, and step 5
 * hashes the **UTF-8 encoding** of the joined string. Paths arrive already UTF-8-decoded (the
 * executor reads git's output with `encoding: "utf8"`), so a filename whose bytes are not valid
 * UTF-8 is lossily replaced with U+FFFD before it reaches the digest.
 *
 * File contents are never normalized: a CRLF/LF difference is visible rather than smoothed away.
 *
 * Two constraints this module's contract places on its callers:
 *
 * - **Runner output must live outside `specDir`.** `test-results/`, `playwright-report/`, and any
 *   `.auth/` storage-state directory have to sit outside the spec directory. The dirty check refuses
 *   gitignored files as well as untracked ones — without that, an ignored spec file is invisible to
 *   both the check and the digest, which is a one-run way to smuggle an unreviewed executable spec
 *   into a tree the anchor then certifies as clean (CONTEXT.md:345). The cost of closing it is that
 *   a runner writing its artifacts under `specDir` makes every later run refuse.
 * - **The anchor covers files, not the code that runs, and the gap is wider than "some code is
 *   uncovered".** A tracked spec that imports a helper from outside `specDir`, or an ignored one, is
 *   the small case. The larger one is that a Runtime-Observed Execution reads its result out of a
 *   report the observed process itself writes, and every module deciding what goes in that report —
 *   the runner's own `playwright.config`, a caller-supplied `--config`, `globalSetup`/`globalTeardown`,
 *   fixtures — may live outside `specDir`, and whatever does has no entry in this digest. Nothing
 *   requires any of it to live inside: this digest covers every tracked file under `specDir`, not only
 *   `*.spec.*`, so a fixture kept there is hashed here and reviewed like a spec — but an ordinary
 *   project's config sits at the repository root and this module cannot move it. So unanchored
 *   code does not merely run alongside the anchored bytes: it can determine, or simply author, the
 *   result this anchor ends up attached to. **What this value states is which bytes stood in the spec
 *   tree when it was computed, provably equal to the commit it is recorded beside; it cannot state that
 *   those bytes are what produced a result.** Known, deliberately not closed here, and set out in full
 *   — with the one half that IS closable — on `src/operations/execute-observed-playwright.ts`.
 *
 * Every failure is a `QaSkillsError`; no raw error escapes.
 */
export async function resolveGitAnchor(request: GitAnchorRequest): Promise<GitAnchor> {
  try {
    return await computeGitAnchor(request);
  } catch (error: unknown) {
    if (error instanceof QaSkillsError) throw error;
    // A structural guarantee, not a classifier: a caller of a module whose whole contract is "refuse
    // cleanly" must never receive a raw Error, which the final `else` of `src/cli/program.ts`'s error
    // mapping maps to ABORTED_OR_INTERNAL rather than to a refusal.
    throw new QaSkillsError(`Unable to resolve the git anchor for ${request.specDir}: ${describeFailure(error)}`, "GIT_ANCHOR_FAILED");
  }
}

async function computeGitAnchor(request: GitAnchorRequest): Promise<GitAnchor> {
  const execute = request.execute ?? defaultExecutor;
  const specDirCandidate = await resolveSpecDirCandidate(request.projectRoot, request.specDir);
  const repoRoot = (await runGit(execute, ["rev-parse", "--show-toplevel"], request.projectRoot, "NOT_A_GIT_REPOSITORY", `No git repository contains ${request.projectRoot}`)).trim();
  const specDir = await assertRealpathWithin(repoRoot, specDirCandidate);
  // `--` stops a path being read as a revision; `:(literal)` stops it being read as a glob. Without
  // the magic, a directory named `specs*` or `specs[e2e]` is wildmatched, and the anchor can
  // silently describe a different tracked directory while reporting it clean.
  const relativeSpec = relative(repoRoot, specDir).split(sep).join("/");
  const pathspec = relativeSpec === "" ? "." : `:(literal)${relativeSpec}`;

  const commitSha = (await runGit(execute, ["rev-parse", "HEAD"], repoRoot, "GIT_NO_COMMIT", `Repository ${repoRoot} has no commit at HEAD`)).trim();
  if (!commitShaPattern.test(commitSha)) throw new QaSkillsError(`git reported a HEAD commit that is not a 40-character hex SHA: ${commitSha}`, "GIT_COMMIT_SHA_INVALID");

  const status = await runGit(execute, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--", pathspec], repoRoot, "GIT_STATUS_FAILED", `Unable to read the working-tree status of ${specDir}`);
  if (status.length > 0) {
    throw new QaSkillsError(
      `Spec directory ${specDir} does not match ${commitSha}; commit, revert, or remove these before an observed execution ("!!" marks a gitignored file):\n${status.trimEnd()}`,
      "SPEC_TREE_DIRTY",
    );
  }

  const listed = await runGit(execute, ["ls-files", "-s", "-v", "-z", "--cached", "--", pathspec], repoRoot, "GIT_LS_FILES_FAILED", `Unable to list the tracked files under ${specDir}`);
  const entries = listed.split("\0").filter((record) => record.length > 0).map((record) => parseTrackedEntry(record, specDir));
  if (entries.length === 0) throw new QaSkillsError(`Spec directory ${specDir} has no tracked files at ${commitSha}`, "SPEC_TREE_EMPTY");

  const flagged = entries.filter((entry) => entry.tag !== cachedTag);
  if (flagged.length > 0) {
    throw new QaSkillsError(
      `Spec directory ${specDir} has entries flagged in the index, which hides their working-tree edits from the dirty check `
      + `while those bytes still enter the spec-tree digest. Clear the flag with \`git update-index --no-skip-worktree\` or `
      + `\`--no-assume-unchanged\` before an observed execution (tag then path):\n${flagged.map((entry) => `${entry.tag} ${entry.path}`).join("\n")}`,
      "SPEC_TREE_INDEX_FLAGGED",
    );
  }

  const unsupported = entries.filter((entry) => !regularFileModes.has(entry.mode));
  if (unsupported.length > 0) {
    throw new QaSkillsError(
      `Spec directory ${specDir} contains entries git records as something other than a regular file. A submodule (160000) `
      + `or a symlink (120000) is refused, not skipped: its contents are not covered by the spec-tree digest (mode then path):`
      + `\n${unsupported.map((entry) => `${entry.mode} ${entry.path}`).join("\n")}`,
      "SPEC_TREE_UNSUPPORTED_ENTRY",
    );
  }

  const lines = await Promise.all([...entries].sort(byPathBytes).map((entry) => specTreeLine(repoRoot, entry.path)));
  return { commitSha, specTreeSha256: sha256Text(`qa-skills/spec-tree/v1\n${lines.join("")}`) };
}
