import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QaSkillsError } from "../../src/core/errors.js";
import { resolveGitAnchor } from "../../src/core/git-anchor.js";
import { RunWorkspace, type RegisteredWorkspaceArtifact } from "../../src/core/run-workspace.js";
import { executeObservedPlaywright } from "../../src/operations/execute-observed-playwright.js";
import type { RunnerExecutor, RunnerInvocation } from "../../src/observed/run-playwright.js";
import { removedRunnerReportFields } from "../../src/observed/sanitize-report.js";
import { evaluateWorkspaceCoverage } from "../../src/operations/evaluate-workspace-coverage.js";

/**
 * The lane-2 producer (Task 39b): `qa-skill execute playwright`'s operation.
 *
 * Every test here drives a REAL git repository (the anchor is the point of lane 2) with a SEAM for the
 * runner process, so the registration behaviour is exercised without a Playwright process per case.
 * The end-to-end acceptance test in `tests/e2e/lane2-batch-credited-run.test.ts` runs a real one.
 */

const runFile = promisify(execFile);
const roots: string[] = [];
const repoRoot = process.cwd();

/** `runObservedPlaywright` leaves its temp working directory behind on purpose (a producer reads the
 *  traces out of it). Nothing here consumes them, so the suite sweeps what it caused. */
const observedPrefix = "qa-skills-observed-";
let preexisting: ReadonlySet<string> = new Set();

async function observedTempDirs(): Promise<string[]> {
  return (await readdir(tmpdir()).catch((): string[] => [])).filter((entry) => entry.startsWith(observedPrefix));
}

beforeEach(async () => { preexisting = new Set(await observedTempDirs()); });

afterEach(async () => {
  const strays = (await observedTempDirs()).filter((entry) => !preexisting.has(entry)).map((entry) => join(tmpdir(), entry));
  await Promise.all([...roots.splice(0), ...strays].map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  return (await runFile("git", [...args], { encoding: "utf8", cwd })).stdout;
}

const environmentProfile = {
  artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0",
  environmentProfileId: "ENV-OBSERVED", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false,
} as const;

const testCase = {
  artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "0.1.0",
  testCaseId: "TC-LEDGER", revisionId: "REV-1", instanceId: "INST-1", title: "The ledger balances",
  steps: [{ id: "call", action: "navigate", sideEffect: "none" }],
  coverage: { requirementId: "REQ-LEDGER", role: "auditor", behavior: "balance the ledger", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "high", outcome: "The ledger balances" },
} as const;

const taggedTitle = `the ledger balances [qa:${testCase.testCaseId}/${testCase.revisionId}/${testCase.instanceId}@api]`;

function runnerReport(specs: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    config: { version: "1.61.1", rootDir: "/srv", argv: ["node", "cli.js", "--grep=sk-live-planted"], projects: [] },
    suites: [{ title: "observed.spec.js", file: "specs/observed.spec.js", line: 0, column: 0, specs }],
    errors: [], stats: { expected: 1, unexpected: 0 },
  });
}

function passingSpec(title: string = taggedTitle, id = "aaaa-bbbb"): Record<string, unknown> {
  return { title, ok: true, tags: [], id, file: "specs/observed.spec.js", line: 2, column: 5, tests: [{ projectId: "", projectName: "", status: "expected", results: [{ status: "passed", duration: 4, retry: 0, stdout: [{ text: "sk-live-planted" }], attachments: [], annotations: [], errors: [] }] }] };
}

function failingSpec(): Record<string, unknown> {
  return { title: taggedTitle, ok: false, tags: [], id: "cccc-dddd", file: "specs/observed.spec.js", line: 2, column: 5, tests: [{ projectId: "", projectName: "", status: "unexpected", results: [{ status: "failed", duration: 9, retry: 0, errors: [{ message: "sk-live-planted" }], stdout: [], stderr: [], annotations: [], attachments: [] }] }] };
}

type Spy = { readonly calls: RunnerInvocation[]; readonly execute: RunnerExecutor };

/** Writes the report where the runtime told the runner to put it, so the seam exercises the same
 *  file-reading path a real run does, and records every invocation so a refusal test can assert the
 *  runner was never started rather than only that the call threw. */
function spy(report: string | undefined, exitCode = 0): Spy {
  const calls: RunnerInvocation[] = [];
  return {
    calls,
    execute: async (invocation) => {
      calls.push(invocation);
      const target = invocation.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
      if (report !== undefined && target !== undefined) {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, report);
      }
      return { exitCode, signal: null, stdout: "", stderr: "" };
    },
  };
}

type Fixture = Readonly<{ root: string; runId: string; caseArtifactId: string }>;

/** A temp-dir Playwright project inside its own git repository, holding a run workspace whose planning
 *  artifacts are already registered. The workspace handle is CLOSED before returning: the operation
 *  opens the run itself, exactly as the CLI does, and would otherwise block on this test's own lock. */
async function fixture(options: { readonly classification?: "test" | "production"; readonly productionReadOnly?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "qa-skills-lane2-"));
  roots.push(root);
  await git(root, "init", "-q", "-b", "main", ".");
  await appendFile(join(root, ".git", "config"), ["[user]", "\temail = observed@example.test", "\tname = Observed Test", "[commit]", "\tgpgsign = false", "[core]", "\tautocrlf = false", ""].join("\n"));
  await writeFile(join(root, ".gitignore"), "node_modules/\nqa-results/\n");
  await writeFile(join(root, "playwright.config.js"), "export default { testDir: './specs' };\n");
  await mkdir(join(root, "specs"), { recursive: true });
  await writeFile(join(root, "specs", "observed.spec.js"), "import { test, expect } from '@playwright/test';\ntest('placeholder', () => { expect(1).toBe(1); });\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "spec");
  await symlink(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");

  const profile = { ...environmentProfile, ...(options.classification ? { classification: options.classification } : {}), ...(options.productionReadOnly === undefined ? {} : { productionReadOnly: options.productionReadOnly }) };
  const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: profile });
  const analysis = await workspace.registerArtifactValue({
    type: "requirement-analysis", relationships: [],
    value: { artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "0.1.0", requirementAnalysisId: "RA", statements: [{ requirementId: "REQ-LEDGER", sourceProvenance: { kind: "user", reference: "ticket-1" }, normalizedText: "The ledger must balance.", authority: "AUTHORITATIVE", role: "auditor", rules: [], risks: [], assumptions: [], openQuestions: [] }] },
  });
  await workspace.registerArtifactValue({
    type: "coverage-obligation", relationships: [],
    value: { artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "0.1.0", obligationId: "COV-API", requirementAnalysisArtifactId: analysis.id, requirementId: "REQ-LEDGER", role: "auditor", behavior: "balance the ledger", executionSurface: "api", accessibilityMethod: null, risk: "high", required: true, outcome: "The ledger balances" },
  });
  const registeredCase = await workspace.registerArtifactValue({ type: "test-case", value: testCase, relationships: [] });
  const runId = workspace.runId;
  await workspace.close();
  return { root, runId, caseArtifactId: registeredCase.id };
}

async function registeredOfType(fixtureValue: Fixture, type: string): Promise<readonly RegisteredWorkspaceArtifact[]> {
  const workspace = await RunWorkspace.open(fixtureValue.root, fixtureValue.runId);
  try {
    return (await workspace.readRegisteredArtifacts()).filter((artifact) => artifact.record.type === type);
  } finally {
    await workspace.close();
  }
}

async function refusalOf(promise: Promise<unknown>): Promise<QaSkillsError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof QaSkillsError) return error;
    throw error;
  }
  throw new Error("expected a refusal, but the call resolved");
}

describe("executeObservedPlaywright registration", () => {
  it("registers one batch anchored to the commit and spec tree that ran", async () => {
    const built = await fixture();
    const anchor = await resolveGitAnchor({ projectRoot: built.root, specDir: "specs" });
    const runner = spy(runnerReport([passingSpec()]));

    const execution = await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    const batches = await registeredOfType(built, "test-result-batch");
    expect(batches).toHaveLength(1);
    expect(batches[0]?.value).toMatchObject({ executionId: execution.executionId, runId: built.runId, commitSha: anchor.commitSha, specTreeSha256: anchor.specTreeSha256 });
    expect(batches[0]?.record.provenance).toBe("runtime-observed");
    expect(batches[0]?.value.entries).toEqual([{ entryId: "aaaa-bbbb-0", testCaseId: "TC-LEDGER", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1", status: "PASSED", failureClassification: "NONE", executionSurface: "api", steps: [{ stepId: "result-0", status: "PASSED", durationMs: 4 }] }]);
  }, 60_000);

  it("credits the coverage obligation the entry's own surface names", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([passingSpec()]));

    await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    const coverage = await evaluateWorkspaceCoverage({ root: built.root, runId: built.runId });
    expect(coverage.satisfied).toEqual(["COV-API"]);
    expect(coverage.missing).toEqual([]);
  }, 60_000);

  it("registers the SANITIZED payload as the evidence, never the runner's own report file", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([passingSpec()]));

    await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    const workspace = await RunWorkspace.open(built.root, built.runId);
    try {
      const descriptor = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "evidence" && artifact.value.kind === "runner-report");
      const registeredBytes = await readFile(await workspace.resolve(descriptor?.value.relativePath as string), "utf8");
      expect(registeredBytes).not.toContain("sk-live-planted");
      // `"argv":` and not `argv`: the payload's own disclosure block NAMES `config.argv` as removed,
      // so the bare substring would be found there and the assertion would pass for the wrong reason.
      expect(registeredBytes).not.toContain("\"argv\":");
      expect(JSON.parse(registeredBytes)).toMatchObject({ sanitization: { removed: removedRunnerReportFields } });
    } finally {
      await workspace.close();
    }
  }, 60_000);

  it("binds the evidence to this execution and to no attempt", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([passingSpec()]));

    const execution = await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    const descriptors = (await registeredOfType(built, "evidence")).filter((artifact) => artifact.record.mediaType === undefined);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.record.id).toBe(execution.evidenceArtifactId);
    expect(descriptors[0]?.value).toMatchObject({
      kind: "runner-report", mediaType: "application/json",
      subject: { kind: "observed-execution", executionId: execution.executionId },
      provenance: { captureType: "runner-report", runner: "@playwright/test", exitCode: 0 },
    });
  }, 60_000);

  it("attaches the evidence to failing entries only, and declares it as a relationship of the batch", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([failingSpec(), passingSpec()]), 1);

    const execution = await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    const batch = (await registeredOfType(built, "test-result-batch"))[0];
    const entries = batch?.value.entries as { status: string; evidenceArtifactIds?: string[] }[];
    expect(entries.map((entry) => entry.status)).toEqual(["FAILED", "PASSED"]);
    expect(entries[0]?.evidenceArtifactIds).toEqual([execution.evidenceArtifactId]);
    expect(entries[1]?.evidenceArtifactIds).toBeUndefined();
    expect(batch?.record.relationships).toContain(execution.evidenceArtifactId);
  }, 60_000);

  it("declares every matched test case as a relationship of the batch", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([passingSpec()]));

    await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    expect((await registeredOfType(built, "test-result-batch"))[0]?.record.relationships).toContain(built.caseArtifactId);
  }, 60_000);

  it("reports every excluded spec instead of registering it", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([passingSpec(), passingSpec("an untagged neighbour", "eeee-ffff")]));

    const execution = await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    expect(execution.entryCount).toBe(1);
    expect(execution.excluded).toEqual([{ entryId: "eeee-ffff-0", title: "an untagged neighbour", file: "specs/observed.spec.js", reason: expect.stringContaining("no [qa:") }]);
    expect((await registeredOfType(built, "test-result-batch"))[0]?.value.entries).toHaveLength(1);
  }, 60_000);
});

describe("executeObservedPlaywright refusals", () => {
  it("refuses a run whose specs all resolve to nothing, naming them, and registers no artifact", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([passingSpec("an untagged neighbour")]));

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_NO_ENTRIES");
    expect(refusal.message).toContain("an untagged neighbour");
    expect(await registeredOfType(built, "test-result-batch")).toHaveLength(0);
    expect(await registeredOfType(built, "evidence")).toHaveLength(0);
  }, 60_000);

  it("refuses a production run without the read-only opt-in, without starting the runner", async () => {
    const built = await fixture({ classification: "production", productionReadOnly: false });
    const runner = spy(runnerReport([passingSpec()]));

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_PRODUCTION_DENIED");
    expect(runner.calls).toHaveLength(0);
  }, 60_000);

  it("reads the read-only opt-in from the registered profile rather than from a flag", async () => {
    const built = await fixture({ classification: "production", productionReadOnly: true });
    const runner = spy(runnerReport([passingSpec()]));

    await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    expect(runner.calls).toHaveLength(1);
  }, 60_000);

  it("refuses a spec tree that differs from its commit, without starting the runner", async () => {
    const built = await fixture();
    await writeFile(join(built.root, "specs", "observed.spec.js"), "// edited after the commit\n");
    const runner = spy(runnerReport([passingSpec()]));

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("SPEC_TREE_DIRTY");
    expect(runner.calls).toHaveLength(0);
  }, 60_000);

  it("refuses a browser-tagged spec after the run, registering nothing", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([passingSpec(`the ledger balances [qa:${testCase.testCaseId}/${testCase.revisionId}/${testCase.instanceId}@browser]`)]));

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_SPEC_SURFACE_UNSUPPORTED");
    expect(await registeredOfType(built, "test-result-batch")).toHaveLength(0);
  }, 60_000);

  it("leaves the workspace readable, so the batch<->evidence linkage rule is satisfied by construction", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([failingSpec()]), 1);

    await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    const workspace = await RunWorkspace.open(built.root, built.runId);
    try {
      await expect(workspace.readRegisteredArtifacts()).resolves.toEqual(expect.any(Array));
      expect((await workspace.validate()).diagnostics).toEqual([]);
    } finally {
      await workspace.close();
    }
  }, 60_000);
});
