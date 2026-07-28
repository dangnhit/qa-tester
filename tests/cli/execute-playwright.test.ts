import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";

/**
 * `qa-skill execute playwright` — the CLI surface of lane 2.
 *
 * Two things are pinned here that no other suite can see: that `--` hands the caller's arguments to the
 * runner VERBATIM (proved by the runtime's own refusal of `--reporter`, which only fires if the token
 * reached `runObservedPlaywright`), and that adding that passthrough did not widen option parsing for
 * any other command in the tree.
 */

const runFile = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  return (await runFile("git", [...args], { encoding: "utf8", cwd })).stdout;
}

const environmentProfile = {
  artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0",
  environmentProfileId: "ENV-CLI-LANE2", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false,
} as const;

/** A committed spec tree with a run workspace beside it. No test case is registered: every case here
 *  refuses before mapping, and the refusal is the subject. */
async function fixture(classification: "test" | "production" = "test"): Promise<{ root: string; runId: string }> {
  const root = await mkdtemp(join(tmpdir(), "qa-skills-cli-lane2-"));
  roots.push(root);
  await git(root, "init", "-q", "-b", "main", ".");
  await appendFile(join(root, ".git", "config"), ["[user]", "\temail = observed@example.test", "\tname = Observed Test", "[commit]", "\tgpgsign = false", "[core]", "\tautocrlf = false", ""].join("\n"));
  await writeFile(join(root, ".gitignore"), "node_modules/\nqa-results/\n");
  await mkdir(join(root, "specs"), { recursive: true });
  await writeFile(join(root, "specs", "observed.spec.js"), "import { test, expect } from '@playwright/test';\ntest('placeholder', () => { expect(1).toBe(1); });\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "spec");
  // `runObservedPlaywright` resolves the runner BEFORE the anchor, so without a real install every case
  // below would refuse with OBSERVED_RUNNER_MISSING and prove nothing about the refusal it names.
  await symlink(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
  const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: { ...environmentProfile, classification } });
  const runId = workspace.runId;
  await workspace.close();
  return { root, runId };
}

describe("qa-skill execute playwright argument passthrough", () => {
  it("hands everything after `--` to the runner verbatim", async () => {
    const built = await fixture();

    const result = await runCli(["execute", "playwright", "--root", built.root, "--run-id", built.runId, "--spec-dir", "specs", "--", "--reporter=json"], { cwd: built.root });

    // Only `runObservedPlaywright` knows this token is runtime-owned, so seeing its refusal proves the
    // argument travelled through Commander untouched instead of being parsed as a CLI option.
    expect(result.stderr).toContain("The QA Runtime owns --reporter");
    expect(result.exitCode).toBe(ExitCode.INVALID_INPUT);
  }, 60_000);

  it("still rejects an unknown option written BEFORE the `--`", async () => {
    const built = await fixture();

    const result = await runCli(["execute", "playwright", "--root", built.root, "--run-id", built.runId, "--spec-dir", "specs", "--workers=1"], { cwd: built.root });

    expect(result.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(result.stderr).toContain("unknown option");
  }, 60_000);

  it.each([
    [["validate", "--root", ".", "--run-id", "R", "--nope"]],
    [["run", "create", "--root", ".", "--mode", "execute", "--environment-file", "e.json", "--nope"]],
    [["artifact", "ingest", "--root", ".", "--run-id", "R", "--type", "evidence", "--file", "f.json", "--nope"]],
    [["attestation", "record", "--root", ".", "--run-id", "R", "--obligation-id", "O", "--method", "keyboard", "--attested-by", "a", "--statement", "s", "--nope"]],
  ])("leaves every other command's option parsing unchanged: %s", async (argv) => {
    const directory = await mkdtemp(join(tmpdir(), "qa-skills-cli-parse-"));
    roots.push(directory);

    const result = await runCli(argv, { cwd: directory });

    expect(result.stderr).toContain("unknown option '--nope'");
    expect(result.exitCode).toBe(ExitCode.INVALID_INPUT);
  });
});

describe("qa-skill execute playwright exit codes", () => {
  it("maps a spec tree that differs from its commit to BLOCKED", async () => {
    const built = await fixture();
    await writeFile(join(built.root, "specs", "observed.spec.js"), "// edited after the commit\n");

    const result = await runCli(["execute", "playwright", "--root", built.root, "--run-id", built.runId, "--spec-dir", "specs"], { cwd: built.root });

    expect(result.exitCode).toBe(ExitCode.BLOCKED);
    expect(result.stderr).toContain("commit, revert, or remove these");
  }, 60_000);

  it("maps the production refusal to SAFETY_DENIED", async () => {
    const built = await fixture("production");

    const result = await runCli(["execute", "playwright", "--root", built.root, "--run-id", built.runId, "--spec-dir", "specs"], { cwd: built.root });

    expect(result.exitCode).toBe(ExitCode.SAFETY_DENIED);
    expect(result.stderr).toContain("read-only opt-in");
  }, 60_000);

  it("leaves every other observed refusal on INVALID_INPUT", async () => {
    const built = await fixture();

    const result = await runCli(["execute", "playwright", "--root", built.root, "--run-id", built.runId, "--spec-dir", "does-not-exist"], { cwd: built.root });

    expect(result.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(result.stderr).toContain("Spec directory does not exist");
  }, 60_000);
});
