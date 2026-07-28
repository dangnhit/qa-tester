import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { QaSkillsError } from "../../src/core/errors.js";
import { resolveGitAnchor } from "../../src/core/git-anchor.js";
import { runObservedPlaywright } from "../../src/observed/run-playwright.js";
import type { RunnerExecutor, RunnerExit, RunnerInvocation } from "../../src/observed/run-playwright.js";

const runFile = promisify(execFile);
const roots: string[] = [];
const repoRoot = process.cwd();

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  return (await runFile("git", [...args], { encoding: "utf8", cwd })).stdout;
}

async function newTempDir(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `qa-skills-observed-${label}-`));
  roots.push(root);
  return root;
}

/** A temp-dir Playwright project inside its own git repository. Identity and line-ending handling are
 *  pinned in `.git/config` so no outcome depends on the ambient git configuration of the machine.
 *  `node_modules` is a symlink to this repository's own install (and gitignored), which is exactly the
 *  shape decision 3 refuses to realpath-assert: a pnpm/yarn store legitimately links out of the tree. */
async function newProject(label: string, spec: string, options: { readonly withRunner?: boolean; readonly config?: string } = {}): Promise<string> {
  const root = await newTempDir(label);
  await git(root, "init", "-q", "-b", "main", ".");
  await appendFile(join(root, ".git", "config"), ["[user]", "\temail = observed@example.test", "\tname = Observed Test", "[commit]", "\tgpgsign = false", "[core]", "\tautocrlf = false", ""].join("\n"));
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await writeFile(join(root, "playwright.config.js"), options.config ?? "export default { testDir: './specs' };\n");
  await mkdir(join(root, "specs"), { recursive: true });
  await writeFile(join(root, "specs", "observed.spec.js"), spec);
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "spec");
  if (options.withRunner !== false) await symlink(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}

const passingSpec = "import { test, expect } from '@playwright/test';\ntest('arithmetic holds', () => { expect(1 + 1).toBe(2); });\n";
const failingSpec = "import { test, expect } from '@playwright/test';\ntest('arithmetic is broken', () => { expect(1 + 1).toBe(3); });\n";
const chromiumSpec = [
  "import { test, expect } from '@playwright/test';",
  "test('a chromium page reports its title', async ({ page }) => {",
  "  await page.setContent('<title>observed</title><h1>hi</h1>');",
  "  await expect(page).toHaveTitle('observed');",
  "});",
  "",
].join("\n");

type Spy = { readonly calls: RunnerInvocation[]; readonly execute: RunnerExecutor };

/** Records every invocation so a refusal test can assert the runner was never started, rather than
 *  only that the call threw — a throw alone is also what a spawn that failed afterwards looks like. */
function spy(outcome: (invocation: RunnerInvocation) => Promise<RunnerExit> = () => Promise.resolve({ exitCode: 0, signal: null })): Spy {
  const calls: RunnerInvocation[] = [];
  return { calls, execute: (invocation) => { calls.push(invocation); return outcome(invocation); } };
}

/** Writes what a passing single-test report looks like to wherever the runtime told the runner to put
 *  it, so a seam-driven test exercises the same file-reading path a real run does. */
async function writeReport(invocation: RunnerInvocation, contents: string): Promise<void> {
  const target = invocation.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  if (!target) throw new Error("the runtime did not tell the runner where to write its JSON report");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

const validReport = JSON.stringify({ config: { version: "1.61.1", projects: [] }, suites: [], errors: [], stats: { expected: 0 } });
const local = { classification: "local", productionReadOnly: false } as const;

async function refusalOf(promise: Promise<unknown>): Promise<QaSkillsError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof QaSkillsError) return error;
    throw error;
  }
  throw new Error("expected a refusal, but the call resolved");
}

describe("runObservedPlaywright refusals", () => {
  it("refuses a spec tree that differs from its commit without starting the runner", async () => {
    const root = await newProject("dirty", passingSpec);
    await writeFile(join(root, "specs", "observed.spec.js"), `${passingSpec}// edited after the commit\n`);
    const runner = spy();

    const refusal = await refusalOf(runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [], environment: local, execute: runner.execute }));

    expect(refusal.code).toBe("SPEC_TREE_DIRTY");
    expect(runner.calls).toHaveLength(0);
  }, 60_000);

  it("refuses a production environment without the read-only opt-in without starting the runner", async () => {
    const root = await newProject("production-denied", passingSpec);
    const runner = spy();

    const refusal = await refusalOf(runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [], environment: { classification: "production", productionReadOnly: false }, execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_PRODUCTION_DENIED");
    expect(runner.calls).toHaveLength(0);
  }, 60_000);

  it("runs in production once the read-only opt-in is recorded", async () => {
    const root = await newProject("production-allowed", passingSpec);
    const runner = spy(async (invocation) => { await writeReport(invocation, validReport); return { exitCode: 0, signal: null }; });

    const run = await runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [], environment: { classification: "production", productionReadOnly: true }, execute: runner.execute });

    expect(run.exitCode).toBe(0);
    expect(runner.calls).toHaveLength(1);
  }, 60_000);

  it("refuses when the runner is absent from node_modules and never falls back to a playwright on PATH", async () => {
    const root = await newProject("runner-missing", passingSpec, { withRunner: false });
    const decoy = await newTempDir("decoy-path");
    const marker = join(decoy, "decoy-was-executed");
    await writeFile(join(decoy, "playwright"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    await writeFile(join(decoy, "playwright.cmd"), `@echo off\r\ntype nul > ${JSON.stringify(marker)}\r\n`);
    await chmod(join(decoy, "playwright"), 0o755);
    vi.stubEnv("PATH", `${decoy}${delimiter}${process.env.PATH ?? ""}`);
    const runner = spy();

    const refusal = await refusalOf(runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [], environment: local, execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUNNER_MISSING");
    expect(refusal.message).toMatch(/install/i);
    expect(runner.calls).toHaveLength(0);
    await expect(readFile(marker)).rejects.toThrow();
  }, 60_000);

  it.each([["--reporter"], ["--reporter=json"], ["--output"], ["--output=elsewhere"]])("refuses the caller argument %s without starting the runner", async (argument) => {
    const root = await newProject("argument", passingSpec);
    const runner = spy();

    const refusal = await refusalOf(runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [argument], environment: local, execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_ARGUMENT_REFUSED");
    expect(runner.calls).toHaveLength(0);
  }, 60_000);

  it("refuses a runner killed by a signal even when it left a valid report behind", async () => {
    const root = await newProject("signal", passingSpec);
    const runner = spy(async (invocation) => { await writeReport(invocation, validReport); return { exitCode: null, signal: "SIGKILL" }; });

    const refusal = await refusalOf(runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [], environment: local, execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_KILLED_BY_SIGNAL");
    expect(refusal.message).toContain("SIGKILL");
  }, 60_000);

  it("refuses when the runner wrote no report at all", async () => {
    const root = await newProject("report-missing", passingSpec);
    const runner = spy();

    const refusal = await refusalOf(runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [], environment: local, execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_REPORT_MISSING");
  }, 60_000);

  it("refuses an empty report", async () => {
    const root = await newProject("report-empty", passingSpec);
    const runner = spy(async (invocation) => { await writeReport(invocation, "   \n"); return { exitCode: 0, signal: null }; });

    const refusal = await refusalOf(runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [], environment: local, execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_REPORT_EMPTY");
  }, 60_000);

  it.each([["not json at all"], ["[]"], ["null"], ["42"]])("refuses a report that is not a JSON object (%s)", async (contents) => {
    const root = await newProject("report-unparseable", passingSpec);
    const runner = spy(async (invocation) => { await writeReport(invocation, contents); return { exitCode: 0, signal: null }; });

    const refusal = await refusalOf(runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [], environment: local, execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_REPORT_UNPARSEABLE");
  }, 60_000);

  it("refuses when the installed runner does not state a version", async () => {
    const root = await newProject("version-unreadable", passingSpec, { withRunner: false });
    await mkdir(join(root, "node_modules", "@playwright", "test"), { recursive: true });
    await writeFile(join(root, "node_modules", "@playwright", "test", "cli.js"), "");
    await writeFile(join(root, "node_modules", "@playwright", "test", "package.json"), "{ not json");
    const runner = spy();

    const refusal = await refusalOf(runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [], environment: local, execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUNNER_VERSION_UNREADABLE");
    expect(runner.calls).toHaveLength(0);
  }, 60_000);

  it("converts a failure with no refusal of its own into a QaSkillsError rather than letting it escape raw", async () => {
    const root = await newProject("absent-root", passingSpec);
    const runner = spy();

    const refusal = await refusalOf(runObservedPlaywright({ projectRoot: join(root, "no-such-directory"), specDir: "specs", args: [], environment: local, execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_FAILED");
    expect(runner.calls).toHaveLength(0);
  }, 60_000);

  it("refuses when the runner could not be started at all", async () => {
    const root = await newProject("spawn-failed", passingSpec);
    const runner = spy(() => Promise.reject(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));

    const refusal = await refusalOf(runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [], environment: local, execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_SPAWN_FAILED");
  }, 60_000);
});

describe("runObservedPlaywright observations", () => {
  it("returns a non-zero exit code as an observation rather than a refusal", async () => {
    const root = await newProject("failing-exit", passingSpec);
    const runner = spy(async (invocation) => { await writeReport(invocation, validReport); return { exitCode: 1, signal: null }; });

    const run = await runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [], environment: local, execute: runner.execute });

    expect(run.exitCode).toBe(1);
    expect(run.report).toMatchObject({ stats: { expected: 0 } });
  }, 60_000);

  it("spawns this process's node against the project's own cli.js, never a shell and never the .bin shim", async () => {
    const root = await newProject("invocation", passingSpec);
    const runner = spy(async (invocation) => { await writeReport(invocation, validReport); return { exitCode: 0, signal: null }; });

    await runObservedPlaywright({ projectRoot: root, specDir: "specs", args: ["--workers=1"], environment: local, execute: runner.execute });

    const invocation = runner.calls[0];
    expect(invocation?.command).toBe(process.execPath);
    expect(invocation?.args[0]).toBe(join(root, "node_modules", "@playwright", "test", "cli.js"));
    expect(invocation?.args[1]).toBe("test");
    // The runtime's own flags precede the caller's: `--` ends option parsing in the runner's argument
    // parser, so a caller-supplied `--` placed before them would demote `--reporter=json` to a test filter.
    expect(invocation?.args.slice(2, 4)).toEqual(["--reporter=json", expect.stringMatching(/^--output=/) as unknown as string]);
    expect(invocation?.args.at(-1)).toBe("--workers=1");
  }, 60_000);

  it("forces the runner's output directory and JSON report outside the spec directory", async () => {
    const root = await newProject("output-outside", passingSpec);
    const runner = spy(async (invocation) => { await writeReport(invocation, validReport); return { exitCode: 0, signal: null }; });

    await runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [], environment: local, execute: runner.execute });

    const invocation = runner.calls[0];
    const outputDir = invocation?.args.find((argument) => argument.startsWith("--output="))?.slice("--output=".length) ?? "";
    expect(outputDir).not.toBe("");
    expect(outputDir.startsWith(join(root, "specs"))).toBe(false);
    expect(invocation?.env.PLAYWRIGHT_JSON_OUTPUT_FILE?.startsWith(join(root, "specs"))).toBe(false);
  }, 60_000);

  it("records nothing the caller typed: no argv and no environment reach the return value", async () => {
    const root = await newProject("no-argv", passingSpec);
    const secret = "--grep=token-abcdef0123456789";
    const reportWithArgv = JSON.stringify({ config: { version: "1.61.1", argv: ["node", "cli.js", "test", secret], projects: [] }, suites: [], errors: [], stats: {} });
    const runner = spy(async (invocation) => { await writeReport(invocation, reportWithArgv); return { exitCode: 0, signal: null }; });

    const run = await runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [secret], environment: local, execute: runner.execute });

    expect(JSON.stringify(run)).not.toContain(secret);
    expect(JSON.stringify(run)).not.toContain("argv");
  }, 60_000);

  it("returns a report that carries no config object unchanged, rather than assuming the reporter's shape", async () => {
    const root = await newProject("no-config", passingSpec);
    const runner = spy(async (invocation) => { await writeReport(invocation, JSON.stringify({ suites: [], stats: { expected: 0 } })); return { exitCode: 0, signal: null }; });

    const run = await runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [], environment: local, execute: runner.execute });

    expect(run.report).toEqual({ suites: [], stats: { expected: 0 } });
  }, 60_000);

  it("reports the runner it actually resolved and that runner's installed version", async () => {
    const root = await newProject("runner-identity", passingSpec);
    const installed = JSON.parse(await readFile(join(repoRoot, "node_modules", "@playwright", "test", "package.json"), "utf8")) as { version: string };
    const runner = spy(async (invocation) => { await writeReport(invocation, validReport); return { exitCode: 0, signal: null }; });

    const run = await runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [], environment: local, execute: runner.execute });

    expect(run.runner).toBe("@playwright/test");
    expect(run.runnerVersion).toBe(installed.version);
  }, 60_000);

  it("carries the anchor of the spec tree that ran and timestamps that bracket the run", async () => {
    const root = await newProject("anchor", passingSpec);
    const expected = await resolveGitAnchor({ projectRoot: root, specDir: "specs" });
    const runner = spy(async (invocation) => { await writeReport(invocation, validReport); return { exitCode: 0, signal: null }; });

    const run = await runObservedPlaywright({ projectRoot: root, specDir: "specs", args: [], environment: local, execute: runner.execute });

    expect(run.anchor).toEqual(expected);
    expect(Date.parse(run.finishedAt)).toBeGreaterThanOrEqual(Date.parse(run.startedAt));
    expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  }, 60_000);
});

describe("runObservedPlaywright against a real Playwright process", () => {
  it("observes a passing spec that needs no browser", async () => {
    const root = await newProject("real-no-browser", passingSpec);

    const run = await runObservedPlaywright({ projectRoot: root, specDir: "specs", args: ["--workers=1"], environment: local });

    expect(run.exitCode).toBe(0);
    expect(run.runnerVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(run.report).toMatchObject({ stats: { expected: 1, unexpected: 0 } });
  }, 120_000);

  it("observes a failing spec as a non-zero exit with a report, not as a refusal", async () => {
    const root = await newProject("real-failing", failingSpec);

    const run = await runObservedPlaywright({ projectRoot: root, specDir: "specs", args: ["--workers=1"], environment: local });

    expect(run.exitCode).toBe(1);
    expect(run.report).toMatchObject({ stats: { unexpected: 1 } });
  }, 120_000);

  it("leaves the spec tree anchorable even when the project's own config aims its output at the spec directory", async () => {
    // Both of these would land gitignored artifacts under `specs/`, and the anchor's dirty check
    // refuses gitignored files — so without the forced output directory the first successful run makes
    // every run after it refuse. The runtime's `--output` and `--reporter` must beat the config.
    const hostileConfig = "export default { testDir: './specs', outputDir: './specs/test-results', reporter: [['html', { outputFolder: './specs/playwright-report', open: 'never' }]] };\n";
    const root = await newProject("real-reanchor", passingSpec, { config: hostileConfig });
    const before = await resolveGitAnchor({ projectRoot: root, specDir: "specs" });

    const run = await runObservedPlaywright({ projectRoot: root, specDir: "specs", args: ["--workers=1"], environment: local });

    expect(run.exitCode).toBe(0);
    await expect(resolveGitAnchor({ projectRoot: root, specDir: "specs" })).resolves.toEqual(before);
    await expect(readFile(join(root, "specs", "playwright-report", "index.html"))).rejects.toThrow();
  }, 120_000);

  it("observes a real chromium spec and reports the fields Task 39b consumes", async () => {
    const root = await newProject("real-chromium", chromiumSpec);

    const run = await runObservedPlaywright({ projectRoot: root, specDir: "specs", args: ["--workers=1"], environment: local });

    expect(run.exitCode).toBe(0);
    const spec = (run.report as { suites: { specs: { id: string; title: string; ok: boolean; tests: { status: string; projectName: string; results: { status: string }[] }[] }[] }[] }).suites[0]?.specs[0];
    expect(spec?.id).toMatch(/^[0-9a-f]+-[0-9a-f]+$/);
    expect(spec?.title).toBe("a chromium page reports its title");
    expect(spec?.ok).toBe(true);
    expect(spec?.tests[0]?.status).toBe("expected");
    expect(spec?.tests[0]?.results[0]?.status).toBe("passed");
    // The finding this task exists to surface: the JSON reporter serializes a fixed allowlist of
    // project fields and `use` is not in it, so neither the engine nor the viewport is observable here.
    expect(JSON.stringify(run.report)).not.toContain("browserName");
    expect(JSON.stringify(run.report)).not.toContain("viewport");
  }, 180_000);
});

describe("the pinned real chromium JSON report", () => {
  it("exposes the per-test identity, title and status Task 39b maps from", async () => {
    const report = JSON.parse(await readFile(join(repoRoot, "tests", "fixtures", "playwright-json-report-chromium.json"), "utf8")) as {
      config: { version: string; projects: Record<string, unknown>[] };
      suites: { specs: { id: string; title: string; ok: boolean; file: string; line: number; tests: { status: string; projectName: string; results: { status: string; duration: number }[] }[] }[] }[];
      stats: Record<string, unknown>;
    };

    const spec = report.suites[0]?.specs[0];
    expect(report.config.version).toMatch(/^1\.61\./);
    expect(spec?.id).toMatch(/^[0-9a-f]+-[0-9a-f]+$/);
    expect(spec?.title).toBe("a chromium page reports its title");
    expect(spec?.file).toBe("observed.spec.js");
    expect(spec?.ok).toBe(true);
    expect(spec?.tests[0]?.projectName).toBe("chromium");
    expect(spec?.tests[0]?.status).toBe("expected");
    expect(spec?.tests[0]?.results[0]?.status).toBe("passed");
    expect(typeof spec?.tests[0]?.results[0]?.duration).toBe("number");
  });

  it("exposes NEITHER the browser engine NOR the viewport, which is the finding Task 39b must plan around", async () => {
    const raw = await readFile(join(repoRoot, "tests", "fixtures", "playwright-json-report-chromium.json"), "utf8");
    const report = JSON.parse(raw) as { config: { projects: Record<string, unknown>[] } };

    // `chromium` appears only as a project id/name — a label the caller chose, never observed engine data.
    expect(Object.keys(report.config.projects[0] ?? {}).sort()).toEqual(["id", "metadata", "name", "outputDir", "repeatEach", "retries", "testDir", "testIgnore", "testMatch", "timeout"]);
    expect(raw).not.toContain("browserName");
    expect(raw).not.toContain("viewport");
    expect(raw).not.toContain("executionSurface");
    // And the pinned report carries no argv, which is what decision 10 forbids the return value to carry.
    expect(raw).not.toContain("argv");
  });
});
