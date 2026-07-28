import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { QaSkillsError } from "../../src/core/errors.js";
import { resolveGitAnchor } from "../../src/core/git-anchor.js";
import type { GitExecutor } from "../../src/core/git-anchor.js";

const runFile = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  return (await runFile("git", [...args], { encoding: "utf8", cwd })).stdout;
}

async function newTempDir(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `qa-skills-git-anchor-${label}-`));
  roots.push(root);
  return root;
}

/** A temp-dir repository with identity and line-ending handling pinned, so no test outcome depends
 *  on the ambient git configuration of the machine running it. The settings are appended to
 *  `.git/config` rather than set through four more `git config` spawns: every test in this file
 *  drives real git, and process spawns are what makes them slow enough to hit a test timeout. */
async function newRepo(label: string): Promise<string> {
  const root = await newTempDir(label);
  await git(root, "init", "-q", "-b", "main", ".");
  await appendFile(join(root, ".git", "config"), [
    "[user]",
    "\temail = anchor@example.test",
    "\tname = Anchor Test",
    "[commit]",
    "\tgpgsign = false",
    "[core]",
    "\tautocrlf = false",
    "",
  ].join("\n"));
  return root;
}

async function writeFileAt(root: string, relativePath: string, contents: string | Uint8Array): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function commitAll(root: string, message: string): Promise<string> {
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", message);
  return (await git(root, "rev-parse", "HEAD")).trim();
}

async function anchorOf(root: string, specDir = "specs"): Promise<string> {
  return (await resolveGitAnchor({ projectRoot: root, specDir })).specTreeSha256;
}

/** Re-implements the normative definition independently of the module under test. The caller
 *  supplies the entries already in the byte order the digest requires, so a wrong sort in the
 *  implementation cannot be mirrored here. */
function digestOfOrderedEntries(entries: readonly (readonly [string, string])[]): string {
  const lines = entries.map(([path, contents]) => `${path}\0${createHash("sha256").update(contents).digest("hex")}\n`);
  return createHash("sha256").update(`qa-skills/spec-tree/v1\n${lines.join("")}`).digest("hex");
}

const realGit: GitExecutor = async (args, cwd) => (await runFile("git", [...args], { cwd, encoding: "utf8" })).stdout;

// Every test here spawns several real `git` processes against a real repository, and the file runs
// under `fileParallelism: false` alongside suites that drive Chromium. The default 5s test timeout
// is close enough to the slowest cases (a submodule clone, two repositories built back to back)
// that they flake under load; 30s is generous without hiding a genuine hang.
describe("git anchor", { timeout: 30_000 }, () => {
  it("anchors a clean spec tree to HEAD and to the pinned spec-tree digest", async () => {
    const root = await newRepo("clean");
    await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
    await writeFileAt(root, "specs/nested/b.spec.ts", "beta\n");
    await writeFileAt(root, "README.md", "not a spec\n");
    const head = await commitAll(root, "add specs");

    const anchor = await resolveGitAnchor({ projectRoot: root, specDir: join(root, "specs") });

    expect(anchor.commitSha).toBe(head);
    // Hand-computed with python3/hashlib from the normative definition in the module's TSDoc;
    // regenerating it with this repo's code would pin nothing.
    expect(anchor.specTreeSha256).toBe("a0aa6bf74f75589618197e1e13e64b969807bdf780f467b365d6c0145ef6f4b3");
  });

  it("orders the digest by raw path bytes, not by a case-folding or locale collation", async () => {
    const root = await newRepo("ordering");
    await writeFileAt(root, "specs/B.spec.ts", "bee\n");
    await writeFileAt(root, "specs/a.spec.ts", "ay\n");
    await writeFileAt(root, "specs/nested/deep/c.spec.ts", "see\n");
    await commitAll(root, "add specs");

    // "B" (0x42) sorts before "a" (0x61) by byte; every locale collation puts "a" first.
    expect(await anchorOf(root)).toBe(digestOfOrderedEntries([
      ["specs/B.spec.ts", "bee\n"],
      ["specs/a.spec.ts", "ay\n"],
      ["specs/nested/deep/c.spec.ts", "see\n"],
    ]));
  });

  it("ignores the order git lists tracked files in", async () => {
    const root = await newRepo("emission-order");
    await writeFileAt(root, "specs/B.spec.ts", "bee\n");
    await writeFileAt(root, "specs/a.spec.ts", "ay\n");
    await commitAll(root, "add specs");
    const reversingLsFiles: GitExecutor = async (args, cwd) => {
      const stdout = await realGit(args, cwd);
      if (args[0] !== "ls-files") return stdout;
      return `${stdout.split("\0").filter(Boolean).reverse().join("\0")}\0`;
    };

    const permuted = await resolveGitAnchor({ projectRoot: root, specDir: "specs", execute: reversingLsFiles });

    expect(permuted.specTreeSha256).toBe(digestOfOrderedEntries([
      ["specs/B.spec.ts", "bee\n"],
      ["specs/a.spec.ts", "ay\n"],
    ]));
  });

  it("anchors the repository root itself when it is the spec directory", async () => {
    const root = await newRepo("root-spec-dir");
    await writeFileAt(root, "a.spec.ts", "alpha\n");
    await commitAll(root, "add spec");

    expect(await anchorOf(root, root)).toBe(digestOfOrderedEntries([["a.spec.ts", "alpha\n"]]));
  });

  it.runIf(process.platform !== "win32")("matches the spec directory as a literal path, not as a glob", async () => {
    const root = await newRepo("glob-pathspec");
    await writeFileAt(root, "specs*/a.spec.ts", "real\n");
    await writeFileAt(root, "specsX/decoy.spec.ts", "decoy\n");
    await commitAll(root, "add the real directory and a decoy the glob would match");

    // As a pathspec glob, `specs*` matches specsX/decoy.spec.ts too, and the anchor would
    // silently describe a different tree while reporting it clean.
    expect(await anchorOf(root, "specs*")).toBe(digestOfOrderedEntries([["specs*/a.spec.ts", "real\n"]]));
  });

  it("yields the same spec-tree digest for one commit checked out at two absolute paths", async () => {
    const original = await newRepo("path-independence");
    await writeFileAt(original, "specs/a.spec.ts", "alpha\n");
    await commitAll(original, "add specs");
    const elsewhere = join(await newTempDir("path-independence-copy"), "deeper", "clone");
    await cp(original, elsewhere, { recursive: true });

    expect(await anchorOf(elsewhere)).toBe(await anchorOf(original));
  });

  it("changes the spec-tree digest when a spec file's committed bytes change by one byte", async () => {
    const root = await newRepo("content-sensitivity");
    await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
    await commitAll(root, "add specs");
    const before = await anchorOf(root);

    await writeFileAt(root, "specs/a.spec.ts", "alphb\n");
    await commitAll(root, "edit one byte");

    expect(await anchorOf(root)).not.toBe(before);
  });

  it("changes the spec-tree digest when a spec file is renamed with identical contents", async () => {
    const root = await newRepo("rename-sensitivity");
    await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
    await commitAll(root, "add specs");
    const before = await anchorOf(root);

    await git(root, "mv", "specs/a.spec.ts", "specs/renamed.spec.ts");
    await commitAll(root, "rename");

    expect(await anchorOf(root)).not.toBe(before);
  });

  it("does not hash line endings away: CRLF and LF spec trees anchor differently", async () => {
    const lf = await newRepo("lf");
    await writeFileAt(lf, "specs/a.spec.ts", "alpha\n");
    await commitAll(lf, "add specs");
    const crlf = await newRepo("crlf");
    await writeFileAt(crlf, "specs/a.spec.ts", "alpha\r\n");
    await commitAll(crlf, "add specs");

    expect(await anchorOf(crlf)).not.toBe(await anchorOf(lf));
  });

  it("moves commitSha but not the spec-tree digest when a commit changes only files outside the spec directory", async () => {
    const root = await newRepo("scope");
    await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
    await writeFileAt(root, "README.md", "before\n");
    await commitAll(root, "add specs and readme");
    const first = await resolveGitAnchor({ projectRoot: root, specDir: "specs" });

    await writeFileAt(root, "README.md", "after\n");
    await commitAll(root, "edit readme only");
    const second = await resolveGitAnchor({ projectRoot: root, specDir: "specs" });

    expect(second.commitSha).not.toBe(first.commitSha);
    expect(second.specTreeSha256).toBe(first.specTreeSha256);
  });

  describe("refusals", () => {
    it("refuses a directory that no git repository contains", async () => {
      const root = await newTempDir("not-a-repo");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).rejects.toMatchObject({ code: "NOT_A_GIT_REPOSITORY" });
    });

    it("refuses a repository whose HEAD is unborn", async () => {
      const root = await newRepo("unborn");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await git(root, "add", "-A");

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).rejects.toMatchObject({ code: "GIT_NO_COMMIT" });
    });

    it("refuses a spec directory that lives outside the repository root", async () => {
      const root = await newRepo("outside");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await commitAll(root, "add specs");
      const outside = await newTempDir("outside-target");
      await writeFileAt(outside, "a.spec.ts", "alpha\n");

      await expect(resolveGitAnchor({ projectRoot: root, specDir: outside })).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    });

    it.runIf(process.platform !== "win32")("refuses a spec directory that is a symlink out of the repository", async () => {
      const root = await newRepo("symlink");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await commitAll(root, "add specs");
      const outside = await newTempDir("symlink-target");
      await writeFileAt(outside, "a.spec.ts", "alpha\n");
      await symlink(outside, join(root, "linked-specs"));

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "linked-specs" })).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
    });

    it("refuses a spec directory that does not exist", async () => {
      const root = await newRepo("missing");
      await writeFileAt(root, "README.md", "only this\n");
      await commitAll(root, "add readme");

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).rejects.toMatchObject({ code: "SPEC_DIR_MISSING" });
    });

    it("refuses a spec directory that is a file", async () => {
      const root = await newRepo("not-a-directory");
      await writeFileAt(root, "specs", "alpha\n");
      await commitAll(root, "add file named specs");

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).rejects.toMatchObject({ code: "SPEC_DIR_NOT_A_DIRECTORY" });
    });

    it("refuses a spec directory with nothing committed in it", async () => {
      const root = await newRepo("empty-spec-tree");
      await writeFileAt(root, "README.md", "only this\n");
      await commitAll(root, "add readme");
      await mkdir(join(root, "specs"));

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).rejects.toMatchObject({ code: "SPEC_TREE_EMPTY" });
    });

    it("refuses a spec tree with a modified tracked file", async () => {
      const root = await newRepo("dirty-modified");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await commitAll(root, "add specs");
      await writeFileAt(root, "specs/a.spec.ts", "tampered\n");

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).rejects.toMatchObject({ code: "SPEC_TREE_DIRTY" });
    });

    it("refuses a spec tree with a deleted tracked file before it reads any spec file", async () => {
      const root = await newRepo("dirty-deleted");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await writeFileAt(root, "specs/b.spec.ts", "beta\n");
      await commitAll(root, "add specs");
      await rm(join(root, "specs/b.spec.ts"));

      // A digest computed before this check would fail on the unreadable file instead of refusing.
      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).rejects.toMatchObject({ code: "SPEC_TREE_DIRTY" });
    });

    it("refuses a spec tree with an untracked new file", async () => {
      const root = await newRepo("dirty-untracked");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await commitAll(root, "add specs");
      await writeFileAt(root, "specs/agent-authored.spec.ts", "written this run\n");

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).rejects.toMatchObject({ code: "SPEC_TREE_DIRTY" });
    });

    it("refuses a spec tree with a staged but uncommitted change", async () => {
      const root = await newRepo("dirty-staged");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await commitAll(root, "add specs");
      await writeFileAt(root, "specs/a.spec.ts", "staged\n");
      await git(root, "add", "specs/a.spec.ts");

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).rejects.toMatchObject({ code: "SPEC_TREE_DIRTY" });
    });

    it("refuses a HEAD that git does not report as a 40-character hex SHA", async () => {
      const root = await newRepo("bad-head");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await commitAll(root, "add specs");
      const shortHead: GitExecutor = (args, cwd) => (args[0] === "rev-parse" && args[1] === "HEAD" ? Promise.resolve("0123456789abcdef\n") : realGit(args, cwd));

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs", execute: shortHead })).rejects.toMatchObject({ code: "GIT_COMMIT_SHA_INVALID" });
    });

    it("refuses a spec tree containing a gitignored file, and names it", async () => {
      const root = await newRepo("ignored-spec");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await commitAll(root, "add specs");
      // The .gitignore sits at the repository root, OUTSIDE the spec pathspec, so a scoped
      // `git status` never mentions it. The ignored spec is the file the agent smuggled in:
      // invisible to an untracked-only dirty check and absent from the digest, so the anchor
      // would certify a tree that does not contain the spec sitting on disk next to it.
      await writeFileAt(root, ".gitignore", "specs/evil.spec.ts\n");
      await writeFileAt(root, "specs/evil.spec.ts", "written this run\n");

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).rejects.toMatchObject({
        code: "SPEC_TREE_DIRTY",
        message: expect.stringContaining("specs/evil.spec.ts"),
      });
    });

    // `git status` deliberately suppresses entries carrying these index bits, so a modified spec
    // passes the dirty check while specTreeLine still reads its modified working-tree bytes into
    // the digest: commitSha then names a commit whose tree the digest does not describe. They are
    // two separate index bits, so each needs its own case.
    it("refuses a spec file hidden from the dirty check by --skip-worktree", async () => {
      const root = await newRepo("skip-worktree");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await commitAll(root, "add specs");
      await git(root, "update-index", "--skip-worktree", "specs/a.spec.ts");
      await writeFileAt(root, "specs/a.spec.ts", "unreviewed edit\n");

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).rejects.toMatchObject({
        code: "SPEC_TREE_INDEX_FLAGGED",
        message: expect.stringContaining("specs/a.spec.ts"),
      });
    });

    it("refuses a spec file hidden from the dirty check by --assume-unchanged", async () => {
      const root = await newRepo("assume-unchanged");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await commitAll(root, "add specs");
      await git(root, "update-index", "--assume-unchanged", "specs/a.spec.ts");
      await writeFileAt(root, "specs/a.spec.ts", "unreviewed edit\n");

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).rejects.toMatchObject({
        code: "SPEC_TREE_INDEX_FLAGGED",
        message: expect.stringContaining("specs/a.spec.ts"),
      });
    });

    it("refuses a tracked submodule under the spec directory instead of crashing on it", async () => {
      const root = await newRepo("gitlink");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await commitAll(root, "add specs");
      const inner = await newRepo("gitlink-inner");
      await writeFileAt(inner, "f.txt", "x\n");
      await commitAll(inner, "inner commit");
      await git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "specs/sub");
      await commitAll(root, "add submodule");

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).rejects.toMatchObject({ code: "SPEC_TREE_UNSUPPORTED_ENTRY" });
    });

    it.runIf(process.platform !== "win32")("refuses a tracked symlink under the spec directory", async () => {
      const root = await newRepo("tracked-symlink");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await symlink("a.spec.ts", join(root, "specs/link.spec.ts"));
      await commitAll(root, "add specs with a symlink");

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).rejects.toMatchObject({ code: "SPEC_TREE_UNSUPPORTED_ENTRY" });
    });

    it.runIf(process.platform !== "win32")("refuses a tracked symlink whose target is outside the repository", async () => {
      const root = await newRepo("tracked-symlink-outward");
      const outside = await newTempDir("tracked-symlink-target");
      await writeFileAt(outside, "foreign.txt", "content that is not in any commit\n");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await symlink(join(outside, "foreign.txt"), join(root, "specs/foreign.spec.ts"));
      await commitAll(root, "add specs with an outward symlink");

      // Following this would fold content reachable from no commit into a value that must be
      // reproducible from the commit alone.
      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).rejects.toMatchObject({ code: "SPEC_TREE_UNSUPPORTED_ENTRY" });
    });

    it("refuses a tracked entry whose ls-files record it cannot classify", async () => {
      const root = await newRepo("unclassifiable-entry");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await commitAll(root, "add specs");
      const malformed: GitExecutor = (args, cwd) => (args[0] === "ls-files" ? Promise.resolve("not-an-ls-files-record\0") : realGit(args, cwd));

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs", execute: malformed })).rejects.toMatchObject({ code: "SPEC_TREE_UNSUPPORTED_ENTRY" });
    });

    it("turns an unclassified filesystem failure into a typed refusal rather than a raw Error", async () => {
      const root = await newRepo("structural-typing");
      await writeFileAt(root, "specs/nested/b.spec.ts", "beta\n");
      await commitAll(root, "add specs");
      // A well-formed, unflagged, regular-file record that names a DIRECTORY: it has to survive
      // every typed check so that readFile is what fails, with EISDIR — which src/cli/program.ts
      // would turn into ABORTED_OR_INTERNAL rather than a refusal. The leading "H " tag matters:
      // without it the record fails to parse and this test passes on the parse guard instead,
      // proving nothing about the catch-all.
      const fabricated: GitExecutor = (args, cwd) => (args[0] === "ls-files" ? Promise.resolve(`H 100644 ${"0".repeat(40)} 0\tspecs/nested\0`) : realGit(args, cwd));

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs", execute: fabricated })).rejects.toBeInstanceOf(QaSkillsError);
    });

    it("refuses when git cannot be executed at all", async () => {
      const root = await newRepo("git-absent");
      await writeFileAt(root, "specs/a.spec.ts", "alpha\n");
      await commitAll(root, "add specs");
      const absent: GitExecutor = () => Promise.reject(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }));

      await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs", execute: absent })).rejects.toMatchObject({ code: "GIT_UNAVAILABLE" });
    });
  });
});
