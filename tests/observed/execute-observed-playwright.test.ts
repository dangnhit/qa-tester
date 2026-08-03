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
  artifactType: "test-case", schemaVersion: "3.0.0", producerVersion: "0.1.0",
  testCaseId: "TC-LEDGER", revisionId: "REV-1", instanceId: "INST-1", title: "The ledger balances",
  steps: [{ id: "call", action: "navigate", sideEffect: "none" }],
  coverage: { requirementId: "REQ-LEDGER", role: "auditor", behavior: "balance the ledger", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "high", outcome: "The ledger balances" },
} as const;

const taggedTitle = `the ledger balances [qa:${testCase.testCaseId}/${testCase.revisionId}/${testCase.instanceId}@api]`;

/**
 * The value planted in every field the sanitizer must strip. It looks credential-shaped on purpose —
 * the point of this file is that a realistic-looking secret never reaches a registered artifact — and
 * it survives `npm run scan:secrets` only by an ACCIDENT worth naming: `scripts/check-secrets.ts:9`
 * matches `sk-[A-Za-z0-9_-]{16,}`, and the tail here (`live-planted`) is 12 characters, four short of
 * that minimum. Nothing enforces the gap.
 *
 * So this constant is load-bearing in a way the literal was not: lengthening the tail past 15
 * characters — or planting an `sk-…` value of any length at a new site — reddens the `Deterministic
 * secret and ignore scan` CI job, which has no allowlist and cannot tell a fixture from a leaked key.
 * The assertions below need this string to be unique and greppable; they need nothing from its length.
 * Task 42 left the same warning on the `run-playwright` and `sanitize-report` fixtures, which chose
 * un-credential-shaped values instead.
 */
const plantedSecret = "sk-live-planted";

/** `rootDir` is the fixture's own repository, and `spec.file` is relative to it exactly as
 *  `JSONReporter._relativeLocation` emits it, so the seam exercises the same anchored-spec containment
 *  check a real run does rather than routing around it. */
function runnerReport(specs: readonly Record<string, unknown>[], rootDir: string, outputDir = "/tmp/qa-skills-observed-seam/artifacts"): string {
  return JSON.stringify({
    config: { version: "1.61.1", rootDir, argv: ["node", "cli.js", `--grep=${plantedSecret}`], projects: [{ id: "", name: "", outputDir }] },
    suites: [{ title: "observed.spec.js", file: "specs/observed.spec.js", line: 0, column: 0, specs }],
    errors: [], stats: { expected: 1, unexpected: 0 },
  });
}

function passingSpec(title: string = taggedTitle, id = "aaaa-bbbb"): Record<string, unknown> {
  return { title, ok: true, tags: [], id, file: "specs/observed.spec.js", line: 2, column: 5, tests: [{ projectId: "", projectName: "", status: "expected", results: [{ status: "passed", duration: 4, retry: 0, stdout: [{ text: plantedSecret }], attachments: [], annotations: [], errors: [] }] }] };
}

function failingSpec(): Record<string, unknown> {
  return { title: taggedTitle, ok: false, tags: [], id: "cccc-dddd", file: "specs/observed.spec.js", line: 2, column: 5, tests: [{ projectId: "", projectName: "", status: "unexpected", results: [{ status: "failed", duration: 9, retry: 0, errors: [{ message: plantedSecret }], stdout: [], stderr: [], annotations: [], attachments: [] }] }] };
}

type Spy = { readonly calls: RunnerInvocation[]; readonly execute: RunnerExecutor };

/** Writes the report where the runtime told the runner to put it, so the seam exercises the same
 *  file-reading path a real run does, and records every invocation so a refusal test can assert the
 *  runner was never started rather than only that the call threw.
 *
 *  `duringRun` runs inside the observed process's own window — after the runtime resolved the anchor and
 *  spawned, before the producer sees an exit. That is the only place a `globalTeardown`, a `globalSetup`
 *  or a config-level exit hook can act, so it is where a test has to act to reproduce one. */
function spy(report: string | undefined, exitCode = 0, duringRun?: () => Promise<void>): Spy {
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
      if (duringRun !== undefined) await duringRun();
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
    value: { artifactType: "coverage-obligation", schemaVersion: "4.0.0", producerVersion: "0.1.0", obligationId: "COV-API", requirementAnalysisArtifactId: analysis.id, requirementId: "REQ-LEDGER", role: "auditor", behavior: "balance the ledger", executionSurface: "api", accessibilityMethod: null, risk: "high", required: true, outcome: "The ledger balances" },
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
    const runner = spy(runnerReport([passingSpec()], built.root));

    const execution = await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    const batches = await registeredOfType(built, "test-result-batch");
    expect(batches).toHaveLength(1);
    expect(batches[0]?.value).toMatchObject({ executionId: execution.executionId, runId: built.runId, commitSha: anchor.commitSha, specTreeSha256: anchor.specTreeSha256 });
    expect(batches[0]?.record.provenance).toBe("runtime-observed");
    expect(batches[0]?.value.entries).toEqual([{ entryId: "aaaa-bbbb-0", testCaseId: "TC-LEDGER", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1", status: "PASSED", failureClassification: "NONE", executionSurface: "api", steps: [{ stepId: "result-0", status: "PASSED", durationMs: 4 }] }]);
  }, 60_000);

  it("credits the coverage obligation the entry's own surface names", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([passingSpec()], built.root));

    await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    const coverage = await evaluateWorkspaceCoverage({ root: built.root, runId: built.runId });
    expect(coverage.satisfied).toEqual(["COV-API"]);
    expect(coverage.missing).toEqual([]);
  }, 60_000);

  it("registers the SANITIZED payload as the evidence, never the runner's own report file", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([passingSpec()], built.root));

    await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    const workspace = await RunWorkspace.open(built.root, built.runId);
    try {
      const descriptor = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "evidence" && artifact.value.kind === "runner-report");
      const registeredBytes = await readFile(await workspace.resolve(descriptor?.value.relativePath as string), "utf8");
      expect(registeredBytes).not.toContain(plantedSecret);
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
    const runner = spy(runnerReport([passingSpec()], built.root));

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
    const runner = spy(runnerReport([failingSpec(), passingSpec()], built.root), 1);

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
    const runner = spy(runnerReport([passingSpec()], built.root));

    await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    expect((await registeredOfType(built, "test-result-batch"))[0]?.record.relationships).toContain(built.caseArtifactId);
  }, 60_000);

  it("reports every excluded spec instead of registering it", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([passingSpec(), passingSpec("an untagged neighbour", "eeee-ffff")], built.root));

    const execution = await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    expect(execution.entryCount).toBe(1);
    expect(execution.excluded).toEqual([{ entryId: "eeee-ffff-0", title: "an untagged neighbour", file: "specs/observed.spec.js", reason: expect.stringContaining("no [qa:") }]);
    expect((await registeredOfType(built, "test-result-batch"))[0]?.value.entries).toHaveLength(1);
  }, 60_000);

  it("prints where the runner's own output was left, so the report the evidence omits is findable", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([passingSpec()], built.root, "/tmp/qa-skills-observed-abc123/artifacts"));

    const execution = await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    // The parent of the runner's forced artifact directory: `runObservedPlaywright` passes
    // `--output=<workDir>/artifacts`, and Playwright's CLI `--output` overrides every project's
    // `outputDir`. The e2e suite pins the same derivation against a real run's files on disk.
    expect(execution.runnerWorkingDir).toBe("/tmp/qa-skills-observed-abc123");
  }, 60_000);

  it("omits the working directory rather than inventing one when the report named no project output", async () => {
    const built = await fixture();
    const runner = spy(JSON.stringify({
      config: { version: "1.61.1", rootDir: built.root, projects: [] },
      suites: [{ title: "observed.spec.js", specs: [passingSpec()] }], errors: [], stats: {},
    }));

    const execution = await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    expect(execution.runnerWorkingDir).toBeUndefined();
    expect(Object.keys(execution)).not.toContain("runnerWorkingDir");
  }, 60_000);
});

describe("executeObservedPlaywright anchored-spec containment", () => {
  it("refuses a run whose specs resolve outside the anchored directory, naming them, and registers nothing", async () => {
    const built = await fixture();
    await writeFile(join(built.root, "elsewhere.spec.js"), "// not under specs/\n");
    const strayed = passingSpec();
    strayed.file = "elsewhere.spec.js";
    const runner = spy(runnerReport([strayed], built.root));

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_SPEC_OUTSIDE_ANCHOR");
    expect(refusal.message).toContain("elsewhere.spec.js");
    expect(refusal.message).toContain("crediting unreviewed code");
    expect(await registeredOfType(built, "test-result-batch")).toHaveLength(0);
    expect(await registeredOfType(built, "evidence")).toHaveLength(0);
  }, 60_000);

  it("judges containment on physical paths, so a sibling directory sharing a prefix does not pass", async () => {
    const built = await fixture();
    // `specs2` is a string-prefix match for `specs` and must still be refused.
    await mkdir(join(built.root, "specs2"), { recursive: true });
    await writeFile(join(built.root, "specs2", "observed.spec.js"), "// a sibling, not a child\n");
    const sibling = passingSpec();
    sibling.file = "specs2/observed.spec.js";
    const runner = spy(runnerReport([sibling], built.root));

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_SPEC_OUTSIDE_ANCHOR");
    expect(refusal.message).toContain("specs2");
  }, 60_000);

  it("refuses a report that names no rootDir, since it cannot place what ran", async () => {
    const built = await fixture();
    const runner = spy(JSON.stringify({
      config: { version: "1.61.1", projects: [] },
      suites: [{ title: "observed.spec.js", specs: [passingSpec()] }], errors: [], stats: {},
    }));

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_SPEC_LOCATION_UNKNOWN");
    expect(await registeredOfType(built, "test-result-batch")).toHaveLength(0);
  }, 60_000);

  it("refuses a spec file the runner named but that cannot be resolved on disk", async () => {
    const built = await fixture();
    const vanished = passingSpec();
    vanished.file = "specs/deleted-mid-run.spec.js";
    const runner = spy(runnerReport([vanished], built.root));

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_SPEC_OUTSIDE_ANCHOR");
    expect(refusal.message).toContain("deleted-mid-run.spec.js");
  }, 60_000);

  it("refuses a spec the runner reported with no file at all", async () => {
    const built = await fixture();
    const unnamed = passingSpec();
    unnamed.file = "";
    const runner = spy(runnerReport([unnamed], built.root));

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_SPEC_OUTSIDE_ANCHOR");
    expect(refusal.message).toContain("no file");
  }, 60_000);
});

describe("executeObservedPlaywright anchor re-verification", () => {
  it("refuses when the spec tree was changed while the runner was running, and registers nothing", async () => {
    const built = await fixture();
    // What an unanchored `globalTeardown` does: the pre-spawn anchor hashed the committed spec bytes,
    // and by the time the runner exits the tree on disk is not the tree that was hashed.
    const runner = spy(runnerReport([passingSpec()], built.root), 0, async () => {
      await writeFile(join(built.root, "specs", "planted.spec.js"), "// written while the runner was running\n");
    });

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_ANCHOR_CHANGED");
    expect(refusal.message).toContain("planted.spec.js");
    expect(runner.calls).toHaveLength(1);
    expect(await registeredOfType(built, "test-result-batch")).toHaveLength(0);
    expect(await registeredOfType(built, "evidence")).toHaveLength(0);
  }, 60_000);

  it("refuses a mutation the run committed on its way out, where the tree is clean but the anchor moved", async () => {
    const built = await fixture();
    // The dirty check cannot see this one: the tree is spotless afterwards. Only comparing the anchor
    // against the pre-spawn value catches it, so this is the case that pins the comparison itself.
    const runner = spy(runnerReport([passingSpec()], built.root), 0, async () => {
      await writeFile(join(built.root, "specs", "planted.spec.js"), "// committed while the runner was running\n");
      await git(built.root, "add", "-A");
      await git(built.root, "commit", "-q", "-m", "planted");
    });

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_ANCHOR_CHANGED");
    // The LIST LINES, not the bare field names: the refusal's closing paragraph says "commitSha and
    // specTreeSha256 are immutable once written", so `toContain("commitSha")` passes on the prose alone
    // and cannot tell which half of the comparison fired. Asserting `- commitSha ` and
    // `- specTreeSha256 ` asserts that both halves ran and both reported.
    expect(refusal.message).toContain("- commitSha ");
    expect(refusal.message).toContain("- specTreeSha256 ");
    expect(await registeredOfType(built, "test-result-batch")).toHaveLength(0);
  }, 60_000);

  it("refuses a run that moved HEAD without touching the spec tree, which only the commit half can see", async () => {
    const built = await fixture();
    // Commits OUTSIDE the anchored directory, so `specTreeSha256` is unchanged and `commitSha` alone
    // moves. This is the one reachable state that separates the two comparisons, and it is the state
    // that proves the commit half can refuse on its own rather than riding along with the digest half.
    const runner = spy(runnerReport([passingSpec()], built.root), 0, async () => {
      await writeFile(join(built.root, "unrelated.txt"), "committed while the runner was running\n");
      await git(built.root, "add", "-A");
      await git(built.root, "commit", "-q", "-m", "unrelated to the spec tree");
    });

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_ANCHOR_CHANGED");
    expect(refusal.message).toContain("- commitSha ");
    // And the digest half stays silent, so the operator is told what actually moved.
    expect(refusal.message).not.toContain("- specTreeSha256 ");
    expect(await registeredOfType(built, "test-result-batch")).toHaveLength(0);
  }, 60_000);

  it("refuses a spec directory swapped for a symlink mid-run, which only the digest half can see", async () => {
    const built = await fixture();
    // The mirror of the test above, and the case that proves the digest half refuses on its own.
    // `other/` is committed BEFORE the run so HEAD stands still across it and `commitSha` cannot move.
    await mkdir(join(built.root, "other"), { recursive: true });
    await writeFile(join(built.root, "other", "swapped.spec.js"), "// a different tracked tree\n");
    await git(built.root, "add", "-A");
    await git(built.root, "commit", "-q", "-m", "a second tracked directory");

    // `resolveSpecDirCandidate` follows symlinks only at the PARENT, and `assertRealpathWithin` returns
    // the resolved candidate, so the second resolution anchors `other/` while still being asked for
    // `specs`. Scoped to `:(literal)other` the tree is spotless and HEAD is untouched: the dirty check
    // and the commit comparison both see nothing, and `specTreeSha256` moves alone.
    //
    // The report names the spec through the SWAPPED path, so it resolves inside the directory `specs`
    // now points at and {@link assertExecutedSpecsAreAnchored} is satisfied. That is what leaves the
    // digest comparison as the only thing between this run and a registered batch — delete it and this
    // test registers one instead of refusing, which is the whole point of the case.
    const swapped = passingSpec();
    swapped.file = "specs/swapped.spec.js";
    const runner = spy(runnerReport([swapped], built.root), 0, async () => {
      await rm(join(built.root, "specs"), { recursive: true, force: true });
      await symlink("other", join(built.root, "specs"), "dir");
    });

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_ANCHOR_CHANGED");
    expect(refusal.message).toContain("- specTreeSha256 ");
    // And the commit half stays silent, so this pins the digest comparison and nothing else.
    expect(refusal.message).not.toContain("- commitSha ");
    expect(await registeredOfType(built, "test-result-batch")).toHaveLength(0);
    expect(await registeredOfType(built, "evidence")).toHaveLength(0);
  }, 60_000);

  it("refuses a size-preserving clean filter that hides a mid-run edit from git status, which only the digest half can see", async () => {
    const built = await fixture();
    // The SECOND state `execute-observed-playwright.ts` names as reaching the digest half alone, and the
    // one its comment claimed was pinned when only the symlink case was. `specTreeLine` hashes the RAW
    // working-tree bytes (`src/core/git-anchor.ts`, whose contract says contents are never normalized)
    // while `git status` compares CLEAN-FILTER OUTPUT against the index blob. A filter whose output is
    // unchanged by the edit therefore leaves the tree spotless at HEAD while the hashed bytes moved.
    //
    // `tr A-Z a-z` is that filter: it is size-preserving, and lowercasing an already-lowercase committed
    // blob is the identity, so `clean(UPPERCASE) === clean(lowercase)` and git sees no difference at all.
    // MEASURED on git 2.44.0 before this test was written — `git status --porcelain --untracked-files=all
    // --ignored=matching -- :(literal)specs` prints nothing after the rewrite — and asserted again below
    // rather than trusted, because a filter that silently failed to run would make this test pass through
    // the DIRTY branch instead, which refuses with the same code.
    await appendFile(join(built.root, ".git", "config"), ["[filter.lowercase]", "\tclean = tr A-Z a-z", ""].join("\n"));
    // Scoped to one file: `observed.spec.js` contains `toBe`, so a filter applied to it would lowercase
    // that too and the tree would be dirty before the run for a reason that has nothing to do with this.
    // And it lives INSIDE the anchored directory, where it must be COMMITTED — measured, an uncommitted
    // `specs/.gitattributes` shows as `?? specs/.gitattributes` in the scoped status and `resolveGitAnchor`
    // refuses SPEC_TREE_DIRTY up front, which looks like this test passing and is not.
    await writeFile(join(built.root, "specs", ".gitattributes"), "filtered.spec.js filter=lowercase\n");
    await writeFile(join(built.root, "specs", "filtered.spec.js"), "// lowercase marker\n");
    await git(built.root, "add", "-A");
    await git(built.root, "commit", "-q", "-m", "a filtered spec");

    const runner = spy(runnerReport([passingSpec()], built.root), 0, async () => {
      await writeFile(join(built.root, "specs", "filtered.spec.js"), "// LOWERCASE MARKER\n");
    });

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    // The tree git can see is still clean, so the dirty check inside the second `resolveGitAnchor` had
    // nothing to report and the refusal below cannot have come from it.
    expect(await git(built.root, "status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--", ":(literal)specs")).toBe("");
    expect(refusal.code).toBe("OBSERVED_RUN_ANCHOR_CHANGED");
    expect(refusal.message).toContain("- specTreeSha256 ");
    // HEAD never moved and the commit half stays silent, so this pins the digest comparison alone.
    expect(refusal.message).not.toContain("- commitSha ");
    expect(await registeredOfType(built, "test-result-batch")).toHaveLength(0);
    expect(await registeredOfType(built, "evidence")).toHaveLength(0);
  }, 60_000);

  it("registers the run when the spec tree is untouched, so the re-check costs a clean run nothing", async () => {
    const built = await fixture();
    // The companion to the three above: the re-check must not refuse a run that changed nothing. A file
    // written OUTSIDE the anchored directory is the ordinary case — the runtime forces the runner's own
    // artifacts there deliberately — and the anchor covers `specs/` alone, so it stays legal.
    const runner = spy(runnerReport([passingSpec()], built.root), 0, async () => {
      await writeFile(join(built.root, "runner-noise.txt"), "written outside the anchored directory\n");
    });

    const execution = await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    expect(execution.entryCount).toBe(1);
    expect(await registeredOfType(built, "test-result-batch")).toHaveLength(1);
  }, 60_000);
});

describe("executeObservedPlaywright refusals", () => {
  it("refuses a run whose specs all resolve to nothing, naming them, and registers no artifact", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([passingSpec("an untagged neighbour")], built.root));

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_NO_ENTRIES");
    expect(refusal.message).toContain("an untagged neighbour");
    expect(await registeredOfType(built, "test-result-batch")).toHaveLength(0);
    expect(await registeredOfType(built, "evidence")).toHaveLength(0);
  }, 60_000);

  it("refuses a production run without the read-only opt-in, without starting the runner", async () => {
    const built = await fixture({ classification: "production", productionReadOnly: false });
    const runner = spy(runnerReport([passingSpec()], built.root));

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_RUN_PRODUCTION_DENIED");
    expect(runner.calls).toHaveLength(0);
  }, 60_000);

  it("reads the read-only opt-in from the registered profile rather than from a flag", async () => {
    const built = await fixture({ classification: "production", productionReadOnly: true });
    const runner = spy(runnerReport([passingSpec()], built.root));

    await executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute });

    expect(runner.calls).toHaveLength(1);
  }, 60_000);

  it("refuses a spec tree that differs from its commit, without starting the runner", async () => {
    const built = await fixture();
    await writeFile(join(built.root, "specs", "observed.spec.js"), "// edited after the commit\n");
    const runner = spy(runnerReport([passingSpec()], built.root));

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("SPEC_TREE_DIRTY");
    expect(runner.calls).toHaveLength(0);
  }, 60_000);

  it("refuses a browser-tagged spec after the run, registering nothing", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([passingSpec(`the ledger balances [qa:${testCase.testCaseId}/${testCase.revisionId}/${testCase.instanceId}@browser]`)], built.root));

    const refusal = await refusalOf(executeObservedPlaywright({ root: built.root, runId: built.runId, specDir: "specs", args: [], execute: runner.execute }));

    expect(refusal.code).toBe("OBSERVED_SPEC_SURFACE_UNSUPPORTED");
    expect(await registeredOfType(built, "test-result-batch")).toHaveLength(0);
  }, 60_000);

  it("leaves the workspace readable, so the batch<->evidence linkage rule is satisfied by construction", async () => {
    const built = await fixture();
    const runner = spy(runnerReport([failingSpec()], built.root), 1);

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
