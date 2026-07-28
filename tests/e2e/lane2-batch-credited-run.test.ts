import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { generateQaReport } from "../../src/operations/generate-qa-report.js";

/**
 * **Phase 7's acceptance criterion.** A QA Run credited ENTIRELY by a Runtime-Observed Execution —
 * no `test-result` artifact anywhere in it — reaches a release gate, and the report counts what ran.
 *
 * A real `@playwright/test` process over a real committed spec tree, driven through the CLI. The spec
 * needs no browser, so this exercises the whole lane without a Chromium launch.
 */

const runFile = promisify(execFile);
const roots: string[] = [];
const repoRoot = process.cwd();

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

const testCase = {
  artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "0.1.0",
  testCaseId: "TC-LEDGER", revisionId: "REV-1", instanceId: "INST-1", title: "The ledger balances",
  steps: [{ id: "call", action: "navigate", sideEffect: "none" }],
  coverage: { requirementId: "REQ-LEDGER", role: "auditor", behavior: "balance the ledger", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "high", outcome: "The ledger balances" },
} as const;

/** The identity tag lives in the `test(...)` title, inside the committed spec tree, so the batch's own
 *  `specTreeSha256` covers it and whoever merged the spec reviewed the claim it makes. */
const spec = [
  "import { test, expect } from '@playwright/test';",
  `test('the ledger balances [qa:${testCase.testCaseId}/${testCase.revisionId}/${testCase.instanceId}@api]', () => {`,
  "  expect(1 + 1).toBe(2);",
  "});",
  "",
].join("\n");

describe("a QA Run credited entirely by an observed batch", () => {
  it("reaches a release gate, and the report counts the entries the batch carried", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-skills-lane2-e2e-"));
    roots.push(root);
    await git(root, "init", "-q", "-b", "main", ".");
    await appendFile(join(root, ".git", "config"), ["[user]", "\temail = observed@example.test", "\tname = Observed Test", "[commit]", "\tgpgsign = false", "[core]", "\tautocrlf = false", ""].join("\n"));
    await writeFile(join(root, ".gitignore"), "node_modules/\nqa-results/\n");
    await writeFile(join(root, "playwright.config.js"), "export default { testDir: './specs' };\n");
    await mkdir(join(root, "specs"), { recursive: true });
    await writeFile(join(root, "specs", "ledger.spec.js"), spec);
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "reviewed suite");
    await symlink(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");

    const environmentPath = join(root, "environment.json");
    await writeFile(environmentPath, JSON.stringify({ artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "ENV-E2E", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false }));

    const created = await runCli(["run", "create", "--root", root, "--mode", "full", "--environment-file", environmentPath], { cwd: root });
    expect(created.exitCode).toBe(ExitCode.SUCCESS);
    const runId = (JSON.parse(created.stdout) as { runId: string }).runId;

    const planning = await RunWorkspace.open(root, runId);
    const analysis = await planning.registerArtifactValue({
      type: "requirement-analysis", relationships: [],
      value: { artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "0.1.0", requirementAnalysisId: "RA", statements: [{ requirementId: "REQ-LEDGER", sourceProvenance: { kind: "user", reference: "ticket-1" }, normalizedText: "The ledger must balance.", authority: "AUTHORITATIVE", role: "auditor", rules: [], risks: [], assumptions: [], openQuestions: [] }] },
    });
    await planning.registerArtifactValue({
      type: "coverage-obligation", relationships: [],
      value: { artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "0.1.0", obligationId: "COV-API", requirementAnalysisArtifactId: analysis.id, requirementId: "REQ-LEDGER", role: "auditor", behavior: "balance the ledger", executionSurface: "api", accessibilityMethod: null, risk: "high", required: true, outcome: "The ledger balances" },
    });
    await planning.registerArtifactValue({ type: "test-case", value: testCase, relationships: [] });
    await planning.close();

    const executed = await runCli(["execute", "playwright", "--root", root, "--run-id", runId, "--spec-dir", "specs", "--", "--workers=1"], { cwd: root });

    expect(executed.stderr).toBe("");
    expect(executed.exitCode).toBe(ExitCode.SUCCESS);
    const execution = JSON.parse(executed.stdout) as { executionId: string; batchArtifactId: string; entryCount: number; excluded: unknown[]; commitSha: string; exitCode: number };
    expect(execution).toMatchObject({ entryCount: 1, excluded: [], exitCode: 0 });
    expect(execution.commitSha).toMatch(/^[a-f0-9]{40}$/);

    const workspace = await RunWorkspace.open(root, runId);
    const artifacts = await workspace.readRegisteredArtifacts();
    // The whole point: nothing in this run is a lane-1 attempt.
    expect(artifacts.filter((artifact) => artifact.record.type === "test-result")).toHaveLength(0);
    expect(artifacts.filter((artifact) => artifact.record.type === "test-result-batch")).toHaveLength(1);

    const report = await generateQaReport({ workspace });
    const gate = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "release-gate");
    await workspace.close();

    expect(gate?.value).toMatchObject({ recommendation: "READY", ruleInputs: { coverage: { requiredMissing: [], optionalGaps: [] } } });
    expect((gate?.value.sourceArtifacts as { id: string; type: string }[]).map((source) => source.type)).toContain("test-result-batch");
    const model = JSON.parse(report.json) as { summary: string; excludedNotRun: string[] };
    expect(model.summary).toContain("1 registered attempts evaluated");
    expect(model.excludedNotRun).toEqual([]);

    // The `full` profile's execution requirement is satisfied by the batch alone, so a batch-only run
    // is structurally complete rather than permanently invalid.
    const validated = await runCli(["validate", "--root", root, "--run-id", runId], { cwd: root });
    expect(validated.exitCode).toBe(ExitCode.SUCCESS);
    expect((JSON.parse(validated.stdout) as { valid: boolean; diagnostics: unknown[] })).toMatchObject({ valid: true, diagnostics: [] });
  }, 180_000);
});
