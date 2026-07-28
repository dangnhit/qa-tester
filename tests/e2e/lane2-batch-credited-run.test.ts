import { execFile } from "node:child_process";
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { generateQaReport } from "../../src/operations/generate-qa-report.js";

/**
 * **Phase 7's acceptance criterion, and the anchoring guarantee it rests on.** A QA Run credited
 * ENTIRELY by a Runtime-Observed Execution — no `test-result` artifact anywhere in it — reaches a
 * release gate and the report counts what ran; and a run whose runner strayed outside the anchored
 * spec directory registers nothing at all.
 *
 * Real `@playwright/test` processes over real committed spec trees, driven through the CLI. The specs
 * need no browser, so the whole lane is exercised without a Chromium launch.
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
function spec(title: string): string {
  return [
    "import { test, expect } from '@playwright/test';",
    `test('${title} [qa:${testCase.testCaseId}/${testCase.revisionId}/${testCase.instanceId}@api]', () => {`,
    "  expect(1 + 1).toBe(2);",
    "});",
    "",
  ].join("\n");
}

async function writeInto(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, relativePath)), { recursive: true });
    await writeFile(join(root, relativePath), contents);
  }
}

/** A committed Playwright project in its own git repository, with this repository's runner linked in. */
async function newProject(label: string, committed: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `qa-skills-lane2-${label}-`));
  roots.push(root);
  await git(root, "init", "-q", "-b", "main", ".");
  await appendFile(join(root, ".git", "config"), ["[user]", "\temail = observed@example.test", "\tname = Observed Test", "[commit]", "\tgpgsign = false", "[core]", "\tautocrlf = false", ""].join("\n"));
  await writeInto(root, committed);
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "reviewed suite");
  await symlink(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}

/** Creates the run through the CLI and registers the planning artifacts the batch will bind to.
 *  `artifact ingest` refuses `test-case` outright and prints no artifact IDs, so the planning half goes
 *  through the same `RunWorkspace` API `workflow bootstrap` uses. */
async function newRun(root: string): Promise<string> {
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
  return runId;
}

async function registeredTypes(root: string, runId: string): Promise<string[]> {
  const workspace = await RunWorkspace.open(root, runId);
  try {
    return (await workspace.readRegisteredArtifacts()).map((artifact) => artifact.record.type);
  } finally {
    await workspace.close();
  }
}

const ignored = "node_modules/\nqa-results/\n";

describe("a QA Run credited entirely by an observed batch", () => {
  it("reaches a release gate, and the report counts the entries the batch carried", async () => {
    const root = await newProject("aligned", {
      ".gitignore": ignored,
      "playwright.config.js": "export default { testDir: './specs' };\n",
      "specs/ledger.spec.js": spec("the ledger balances"),
    });
    const runId = await newRun(root);

    const executed = await runCli(["execute", "playwright", "--root", root, "--run-id", runId, "--spec-dir", "specs", "--", "--workers=1"], { cwd: root });

    expect(executed.stderr).toBe("");
    expect(executed.exitCode).toBe(ExitCode.SUCCESS);
    const execution = JSON.parse(executed.stdout) as { executionId: string; batchArtifactId: string; entryCount: number; excluded: unknown[]; commitSha: string; exitCode: number; runnerWorkingDir: string };
    expect(execution).toMatchObject({ entryCount: 1, excluded: [], exitCode: 0 });
    expect(execution.commitSha).toMatch(/^[a-f0-9]{40}$/);

    // The escape hatch the registered evidence deliberately does not carry: the printed directory must
    // really hold the runner's verbatim report and its artifacts. This is also the detector for the
    // derivation behind `runnerWorkingDir` — a runner that changed the layout reddens here.
    const rawReport = JSON.parse(await readFile(join(execution.runnerWorkingDir, "report.json"), "utf8")) as { config: { version: string } };
    expect(rawReport.config.version).toMatch(/^1\.61\./);
    await expect(access(join(execution.runnerWorkingDir, "artifacts"))).resolves.toBeUndefined();

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

describe("a spec tree the observed process changes while it is running", () => {
  it("refuses the run and registers nothing, because the anchor no longer describes what is on disk", async () => {
    // `globalTeardown` is the honest way to produce this: it is committed, it is real Playwright
    // machinery, and it is OUTSIDE `--spec-dir` — so the anchor never covered it, the dirty check never
    // saw it, and it nonetheless runs with write access to the tree the anchor certifies. The pre-spawn
    // anchor is taken before it runs; only re-resolving afterwards can see what it did.
    const root = await newProject("teardown-mutation", {
      ".gitignore": ignored,
      "playwright.config.js": "export default { testDir: './specs', globalTeardown: './teardown.js' };\n",
      // Relative to the runner's cwd, which the QA Runtime pins to the project root.
      "teardown.js": "import { writeFileSync } from 'node:fs';\nexport default function globalTeardown() {\n  writeFileSync('specs/planted.spec.js', '// written while the run was in progress\\n');\n}\n",
      "specs/ledger.spec.js": spec("the ledger balances"),
    });
    const runId = await newRun(root);

    const executed = await runCli(["execute", "playwright", "--root", root, "--run-id", runId, "--spec-dir", "specs", "--", "--workers=1"], { cwd: root });

    expect(executed.exitCode).toBe(ExitCode.SAFETY_DENIED);
    expect(executed.stderr).toContain("planted.spec.js");
    expect(executed.stderr).toContain("no longer matches the git anchor");
    expect(executed.stdout).toBe("");
    // The teardown really did run — otherwise this test would pass with the check deleted, on a run
    // that simply failed for some other reason.
    await expect(access(join(root, "specs", "planted.spec.js"))).resolves.toBeUndefined();
    const registered = await registeredTypes(root, runId);
    expect(registered).not.toContain("test-result-batch");
    expect(registered).not.toContain("evidence");
  }, 180_000);
});

describe("a runner that strays outside the anchored spec directory", () => {
  it("refuses a caller-supplied --config whose testDir points at unreviewed specs, and registers nothing", async () => {
    // `specs/` is committed and clean, so the anchor resolves; `agent/` and its config are gitignored,
    // written after the commit, and outside the anchored pathspec, so nothing else refuses first. This
    // is the adversarial path: the anchor passes while the agent's own specs are what actually ran.
    const root = await newProject("smuggled-config", {
      ".gitignore": `${ignored}agent/\nagent.config.js\n`,
      "playwright.config.js": "export default { testDir: './specs' };\n",
      "specs/ledger.spec.js": spec("the ledger balances"),
    });
    await writeInto(root, {
      "agent.config.js": "export default { testDir: './agent' };\n",
      "agent/smuggled.spec.js": spec("an agent wrote this one"),
    });
    const runId = await newRun(root);

    const executed = await runCli(["execute", "playwright", "--root", root, "--run-id", runId, "--spec-dir", "specs", "--", "--config=./agent.config.js", "--workers=1"], { cwd: root });

    expect(executed.exitCode).toBe(ExitCode.SAFETY_DENIED);
    expect(executed.stderr).toContain("smuggled.spec.js");
    expect(executed.stderr).toContain("crediting unreviewed code");
    expect(executed.stdout).toBe("");
    const registered = await registeredTypes(root, runId);
    expect(registered).not.toContain("test-result-batch");
    expect(registered).not.toContain("evidence");
  }, 180_000);

  it("refuses a project whose testDir is simply broader than --spec-dir, naming the files to narrow away", async () => {
    const root = await newProject("broad-testdir", {
      ".gitignore": ignored,
      "playwright.config.js": "export default { testDir: './suites' };\n",
      "suites/reviewed/ledger.spec.js": spec("the ledger balances"),
      "suites/draft/sketch.spec.js": spec("a sketch nobody anchored"),
    });
    const runId = await newRun(root);

    const executed = await runCli(["execute", "playwright", "--root", root, "--run-id", runId, "--spec-dir", "suites/reviewed", "--", "--workers=1"], { cwd: root });

    expect(executed.exitCode).toBe(ExitCode.SAFETY_DENIED);
    expect(executed.stderr).toContain("sketch.spec.js");
    // The anchored spec is not listed: only the strays are, so the operator sees what to narrow away.
    expect(executed.stderr).not.toContain("ledger.spec.js");
    expect(await registeredTypes(root, runId)).not.toContain("test-result-batch");
  }, 180_000);
});
