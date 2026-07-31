import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";
import { createEntityId } from "../../src/core/ids.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { generateBugReport } from "../../src/operations/generate-bug-report.js";
import type { WorkflowResult } from "../../src/operations/run-workflow.js";
import { sha256Fingerprint } from "../../src/planning/testcase-revision.js";
import { serveBrowserFixture } from "../../fixtures/browser/server.js";

/**
 * Wart MODE-1's closure condition: every one of the six public workflow modes reached through
 * `qa-skill workflow run`, with its input scaffolded by `qa-skill workflow scaffold` rather than
 * hand-written, so what is asserted is the whole documented path.
 *
 * Before this file exactly two modes ran that way in any test — `plan`
 * (tests/cli/workflow.test.ts) and `full` (tests/operations/awaiting-human-input.test.ts). `execute`,
 * `exploratory`, `retest` and `regression` were exercised only through `createQaTester`
 * (tests/orchestration/runtime-public.e2e.test.ts), which is why nothing noticed that no CLI path
 * populated `changeScopeSources`.
 *
 * The last test is the phase's headline path end to end: a `regression` run pauses at exit 2, the real
 * `qa-skill execute playwright` registers a batch into it, and the resume drives only the residual.
 */

const runFile = promisify(execFile);
const roots: string[] = [];
const repoRoot = process.cwd();
const environment = {
  artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0",
  environmentProfileId: "ENV-MODES", name: "Mode reachability fixture", classification: "test",
  baseUrl: "http://127.0.0.1", productionReadOnly: false,
} as const;
const browserFixture = join(fileURLToPath(new URL(".", import.meta.url)), "../../fixtures/browser/basic.html");
let baseUrl: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  const server = await serveBrowserFixture(browserFixture);
  baseUrl = server.baseUrl;
  closeServer = () => server.close();
});
afterAll(async () => { await closeServer(); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** Lifted from tests/operations/awaiting-human-input.test.ts: the one browser DSL the fixture page
 *  satisfies, so every lane-1 attempt in this file passes and no run finalizes WITH_FAILURES. */
function dsl() {
  return { steps: [
    { id: "open", action: { kind: "open", url: baseUrl }, sideEffect: "none" },
    { id: "fill", action: { kind: "fill", locator: { label: "Email" }, value: "qa@example.test" }, assertions: [{ kind: "value", locator: { label: "Email" }, value: "qa@example.test" }], sideEffect: "none" },
    { id: "save", action: { kind: "click", locator: { role: "button", name: "Save" } }, assertions: [{ kind: "text", locator: { testId: "result" }, text: "Saved" }], sideEffect: "none" },
  ] } as const;
}

type Identity = Readonly<{ testCaseId: string; revisionId: string; instanceId: string }>;

async function newRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `qa-mode-${label}-`));
  roots.push(root);
  return root;
}

async function registeredArtifacts(root: string, runId: string) {
  const workspace = await RunWorkspace.open(root, runId);
  try { return await workspace.readRegisteredArtifacts(); } finally { await workspace.close(); }
}

function typesOf(artifacts: Awaited<ReturnType<typeof registeredArtifacts>>): string[] {
  return artifacts.map((artifact) => artifact.record.type);
}

/**
 * A terminal, PLANNING-ONLY `plan` run holding one auto-approved plan whose single entry is executable,
 * its canonical test case, and one browser obligation that the passing attempt satisfies.
 *
 * Planning-only is a requirement, not a preference: `scaffoldWorkflowInput`'s bundle path
 * (src/cli/workflow.ts) refuses a source run holding any non-planning artifact, so this run can never
 * be the same run as the `bug run` a retest reproduces.
 */
async function planningRun(root: string, identity: Identity, requirementId: string): Promise<string> {
  const source = await RunWorkspace.create({ root, mode: "plan", environmentProfile: environment });
  const execution = dsl();
  const requirement = await source.registerArtifactValue({ type: "requirement-analysis", relationships: [], value: {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: `RA-${identity.testCaseId}`,
    statements: [{ requirementId, sourceProvenance: { kind: "user", reference: "phase8b-task5" }, normalizedText: "Member must be able to save an email.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] }],
  } });
  const plan = await source.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: `PLAN-${identity.testCaseId}`, approvalPolicy: { mode: "auto-approve-safe" },
    testCases: [{
      testCaseId: identity.testCaseId, title: "Save email",
      expectedResults: [{ id: `ER-${identity.testCaseId}`, requirementId, authority: "AUTHORITATIVE", text: "Saved" }],
      steps: [{ id: "plan-open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [],
      browserExecution: { revisionId: identity.revisionId, instanceId: identity.instanceId, browserDsl: execution, browserDslFingerprint: sha256Fingerprint(execution) },
    }],
  } });
  await source.registerArtifactValue({ type: "test-case", relationships: [plan.id], value: {
    artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", ...identity,
    title: "Save email", steps: [{ id: "plan-open", action: "navigate", sideEffect: "none" }],
    coverage: { requirementId, role: "member", behavior: "save email", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
  } });
  await source.registerArtifactValue({ type: "coverage-obligation", relationships: [requirement.id], value: {
    artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0",
    obligationId: `COV-${identity.testCaseId}`, requirementAnalysisArtifactId: requirement.id, requirementId,
    role: "member", behavior: "save email", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 },
    accessibilityMethod: null, risk: "low", required: true, outcome: "Saved",
  } });
  await source.finalize("plan");
  const runId = source.runId;
  await source.close();
  return runId;
}

/**
 * A terminal `plan` run for `regression`: two independent plans over one requirement, one selected by a
 * change scope naming that requirement and one excluded by an explicit `regressionIndex` that matches
 * nothing declared. Lifted from tests/operations/awaiting-human-input.test.ts, where the excluded plan is
 * `human-review` on purpose — a selection that leaked it would pause the run instead of completing.
 */
async function regressionPlanningRun(root: string): Promise<string> {
  const source = await RunWorkspace.create({ root, mode: "plan", environmentProfile: environment });
  const execution = dsl();
  const requirement = await source.registerArtifactValue({ type: "requirement-analysis", relationships: [], value: {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-REG",
    statements: [{ requirementId: "REQ-REG", sourceProvenance: { kind: "user", reference: "phase8b-task5" }, normalizedText: "Member must be able to save an email.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] }],
  } });
  const includedPlan = await source.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-REG-INCLUDED", approvalPolicy: { mode: "auto-approve-safe" },
    testCases: [{
      testCaseId: "TC-REG-INCLUDED", title: "Save email (selected by regression)",
      expectedResults: [{ id: "ER-REG-INCLUDED", requirementId: "REQ-REG", authority: "AUTHORITATIVE", text: "Saved" }],
      steps: [{ id: "plan-open-included", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [],
      browserExecution: { revisionId: "REV-REG-INCLUDED", instanceId: "INSTANCE-REG-INCLUDED", browserDsl: execution, browserDslFingerprint: sha256Fingerprint(execution) },
    }],
  } });
  const excludedPlan = await source.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-REG-EXCLUDED", approvalPolicy: { mode: "human-review" },
    testCases: [{
      testCaseId: "TC-REG-EXCLUDED", title: "Save email (excluded by regression)",
      expectedResults: [{ id: "ER-REG-EXCLUDED", requirementId: "REQ-REG", authority: "AUTHORITATIVE", text: "Saved" }],
      steps: [{ id: "plan-open-excluded", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [],
      browserExecution: { revisionId: "REV-REG-EXCLUDED", instanceId: "INSTANCE-REG-EXCLUDED", browserDsl: execution, browserDslFingerprint: sha256Fingerprint(execution) },
    }],
  } });
  await source.registerArtifactValue({ type: "test-case", relationships: [includedPlan.id], value: {
    artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", testCaseId: "TC-REG-INCLUDED", revisionId: "REV-REG-INCLUDED", instanceId: "INSTANCE-REG-INCLUDED",
    title: "Save email (selected by regression)", steps: [{ id: "plan-open-included", action: "navigate", sideEffect: "none" }],
    coverage: { requirementId: "REQ-REG", role: "member", behavior: "save email", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
  } });
  await source.registerArtifactValue({ type: "test-case", relationships: [excludedPlan.id], value: {
    artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", testCaseId: "TC-REG-EXCLUDED", revisionId: "REV-REG-EXCLUDED", instanceId: "INSTANCE-REG-EXCLUDED",
    title: "Save email (excluded by regression)", steps: [{ id: "plan-open-excluded", action: "navigate", sideEffect: "none" }],
    coverage: { requirementId: "REQ-REG", role: "member", behavior: "save email, excluded", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
    regressionIndex: { requirementIds: [], codeSurfaces: ["excluded-surface"], declaredDependencies: [], gitPaths: [], userScope: [] },
  } });
  await source.registerArtifactValue({ type: "coverage-obligation", relationships: [requirement.id], value: {
    artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0",
    obligationId: "COV-REG", requirementAnalysisArtifactId: requirement.id, requirementId: "REQ-REG",
    role: "member", behavior: "save email", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 },
    accessibilityMethod: null, risk: "low", required: true, outcome: "Saved",
  } });
  await source.finalize("plan");
  const runId = source.runId;
  await source.close();
  return runId;
}

/**
 * A terminal `execute` run holding one FAILED/PRODUCT_DEFECT attempt on `identity` and the `bug-report`
 * generated from it — what `--bug-run-id` names. Adapted from tests/cli/workflow.test.ts.
 *
 * It shares its identity triple with the planning run above because retest matches its imported bundle
 * to the source scenarios by that exact triple (src/operations/run-workflow.ts), never by artifact id.
 */
async function bugRun(root: string, identity: Identity, requirementId: string): Promise<{ runId: string; bugArtifactId: string }> {
  const source = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
  const attemptId = `ATT-${identity.testCaseId}`;
  const requirement = await source.registerArtifactValue({ type: "requirement-analysis", relationships: [], value: {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: `RA-BUG-${identity.testCaseId}`,
    statements: [{ requirementId, sourceProvenance: { kind: "user", reference: "phase8b-task5" }, normalizedText: "Member must be able to save an email.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] }],
  } });
  const plan = await source.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: `PLAN-BUG-${identity.testCaseId}`, approvalPolicy: { mode: "human-review" },
    testCases: [{ testCaseId: identity.testCaseId, title: "Save email", expectedResults: [{ id: `ER-BUG-${identity.testCaseId}`, requirementId, authority: "AUTHORITATIVE", text: "Saved" }], steps: [{ id: "plan-open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [] }],
  } });
  const testcase = await source.registerArtifactValue({ type: "test-case", relationships: [plan.id], value: {
    artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", ...identity,
    title: "Save email", steps: [{ id: "plan-open", action: "navigate", sideEffect: "none" }],
    coverage: { requirementId, role: "member", behavior: "save email", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
  } });
  const attempt = await source.registerArtifactValue({ type: "test-result", relationships: [testcase.id], value: {
    artifactType: "test-result", schemaVersion: "2.0.0", producerVersion: "1.0.0", attemptId, runId: source.runId,
    testCaseId: identity.testCaseId, testCaseRevisionId: identity.revisionId, testCaseInstanceId: identity.instanceId,
    status: "FAILED", failureClassification: "PRODUCT_DEFECT", observedEngine: "chromium",
    steps: [{ stepId: "plan-open", status: "FAILED", durationMs: 1 }],
    startedAt: "2026-07-31T00:00:00.000Z", finishedAt: "2026-07-31T00:01:00.000Z",
  } });
  await source.registerEvidenceBundle({
    binaries: [{ filename: `${identity.testCaseId}.txt`, contents: Buffer.from("failure"), mediaType: "text/plain", captureType: "log" }],
    relationships: [attempt.id],
    descriptor: (binaries) => ({
      artifactType: "evidence", schemaVersion: "3.0.0", producerVersion: "1.0.0", evidenceId: createEntityId(),
      runId: source.runId, subject: { kind: "attempt", attemptId, testCaseId: identity.testCaseId, testCaseRevisionId: identity.revisionId, testCaseInstanceId: identity.instanceId },
      kind: "log", capturedAt: "2026-07-31T00:01:00.000Z", sha256: binaries[0]!.sha256, relativePath: binaries[0]!.relativePath, mediaType: "text/plain",
      binaryArtifactIds: binaries.map((binary) => binary.id),
      binaryArtifacts: binaries.map((binary) => ({ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType })),
      telemetryFindings: [{ kind: "console" as const, level: "error", message: "failure" }],
      provenance: { captureType: "log" as const, url: environment.baseUrl, browser: "chromium", build: "fixture", capturedAt: "2026-07-31T00:01:00.000Z", testcaseId: identity.testCaseId },
    }),
  });
  const generated = await generateBugReport({ workspace: source, attemptId, unsafeRerunReason: "Fixture preserves a single captured production defect observation." });
  if (generated.kind !== "BUG") throw new Error("Expected a product bug report");
  await source.finalize("execute");
  const runId = source.runId;
  await source.close();
  return { runId, bugArtifactId: generated.record.id };
}

describe("every public workflow mode, reached through `qa-skill workflow run`", () => {
  // `--environment-file` alone is NOT enough for `plan`, measured rather than assumed: `plan` is one of
  // the five modes in `ensureCanonicalBundle`'s `needsBundle` list (src/operations/run-workflow.ts), so
  // an input carrying only an environment profile is refused with "Workflow requires a checksum-bound
  // canonical plan bundle". `workflow bootstrap` is the documented way a first bundle comes to exist,
  // so the plan path here is bootstrap -> scaffold -> run, entirely through the CLI.
  it("reaches plan mode end to end through the CLI", async () => {
    const root = await newRoot("plan");
    const paths = {
      environment: join(root, "environment.json"),
      requirement: join(root, "requirement.json"),
      plan: join(root, "plan-draft.json"),
      testcase: join(root, "testcase.json"),
      coverage: join(root, "coverage.json"),
    };
    await Promise.all([
      writeFile(paths.environment, JSON.stringify(environment)),
      writeFile(paths.requirement, JSON.stringify({ artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-PLAN", statements: [{ requirementId: "REQ-PLAN", sourceProvenance: { kind: "user", reference: "phase8b-task5" }, normalizedText: "Member must be able to save an email.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] }] })),
      writeFile(paths.plan, JSON.stringify({ artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-PLAN", approvalPolicy: { mode: "auto-approve-safe" }, testCases: [{ testCaseId: "TC-PLAN", title: "Save email", expectedResults: [{ id: "ER-PLAN", requirementId: "REQ-PLAN", authority: "AUTHORITATIVE", text: "Saved" }], steps: [{ id: "plan-open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [] }] })),
      writeFile(paths.testcase, JSON.stringify({ artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", testCaseId: "TC-PLAN", revisionId: "REV-PLAN", instanceId: "INSTANCE-PLAN", title: "Save email", steps: [{ id: "plan-open", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ-PLAN", role: "member", behavior: "save email", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" } })),
      writeFile(paths.coverage, JSON.stringify({ artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0", obligationId: "COV-PLAN", requirementAnalysisArtifactId: "replaced-atomically", requirementId: "REQ-PLAN", role: "member", behavior: "save email", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", required: true, outcome: "Saved" })),
    ]);

    const bootstrapped = await runCli(["workflow", "bootstrap", "--root", root,
      "--environment-file", paths.environment, "--requirement-file", paths.requirement, "--plan-file", paths.plan,
      "--test-case-file", paths.testcase, "--coverage-file", paths.coverage], { cwd: root });
    expect(bootstrapped.stderr).toBe("");
    expect(bootstrapped.exitCode).toBe(ExitCode.SUCCESS);
    const sourceRunId = (JSON.parse(bootstrapped.stdout) as { runId: string }).runId;

    const scaffolded = await runCli(["workflow", "scaffold", "--root", root, "--mode", "plan",
      "--output", join(root, "plan.json"), "--source-root", root, "--source-run-id", sourceRunId], { cwd: root });
    expect(scaffolded.stderr).toBe("");
    expect(scaffolded.exitCode).toBe(ExitCode.SUCCESS);

    const run = await runCli(["workflow", "run", "--input", join(root, "plan.json")], { cwd: root });

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(ExitCode.SUCCESS);
    const result = JSON.parse(run.stdout) as WorkflowResult;
    expect(result).toMatchObject({ mode: "plan", outcome: "COMPLETED" });
    const types = typesOf(await registeredArtifacts(root, result.runId));
    expect(types).toEqual(expect.arrayContaining(["requirement-analysis", "test-case", "coverage-obligation"]));
  }, 120_000);

  it("reaches execute mode end to end through the CLI", async () => {
    const root = await newRoot("execute");
    const planRunId = await planningRun(root, { testCaseId: "TC-EXEC", revisionId: "REV-EXEC", instanceId: "INSTANCE-EXEC" }, "REQ-EXEC");

    const scaffolded = await runCli(["workflow", "scaffold", "--root", root, "--mode", "execute",
      "--output", join(root, "execute.json"), "--source-root", root, "--source-run-id", planRunId], { cwd: root });
    expect(scaffolded.stderr).toBe("");
    expect(scaffolded.exitCode).toBe(ExitCode.SUCCESS);

    const run = await runCli(["workflow", "run", "--input", join(root, "execute.json")], { cwd: root });

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(ExitCode.SUCCESS);
    const result = JSON.parse(run.stdout) as WorkflowResult;
    expect(result).toMatchObject({ mode: "execute", outcome: "COMPLETED" });
    expect((await registeredArtifacts(root, result.runId)).filter((artifact) => artifact.record.type === "test-result")).toHaveLength(1);
  }, 120_000);

  it("reaches full mode end to end through the CLI", async () => {
    const root = await newRoot("full");
    const planRunId = await planningRun(root, { testCaseId: "TC-FULL", revisionId: "REV-FULL", instanceId: "INSTANCE-FULL" }, "REQ-FULL");

    const scaffolded = await runCli(["workflow", "scaffold", "--root", root, "--mode", "full",
      "--output", join(root, "full.json"), "--source-root", root, "--source-run-id", planRunId], { cwd: root });
    expect(scaffolded.stderr).toBe("");
    expect(scaffolded.exitCode).toBe(ExitCode.SUCCESS);

    const run = await runCli(["workflow", "run", "--input", join(root, "full.json")], { cwd: root });

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(ExitCode.SUCCESS);
    const result = JSON.parse(run.stdout) as WorkflowResult;
    expect(result).toMatchObject({ mode: "full", outcome: "COMPLETED" });
    expect((await registeredArtifacts(root, result.runId)).filter((artifact) => artifact.record.type === "release-gate")).toHaveLength(1);
  }, 120_000);

  it("reaches exploratory mode end to end through the CLI", async () => {
    const root = await newRoot("exploratory");
    await writeFile(join(root, "environment.json"), JSON.stringify(environment));
    await writeFile(join(root, "charter.json"), JSON.stringify({
      charterId: "CHARTER-CLI", mission: "explore checkout", scope: ["checkout"], roles: ["member"],
      heuristics: ["follow the money"], safetyRules: ["RULE-1"],
      actions: [{ actionId: "ACT-1", target: "/checkout", kind: "navigate", sideEffect: "none", safetyRuleId: "RULE-1" }],
      actionBudget: 5, timeBudgetMinutes: 10, stopConditions: ["budget spent"],
    }));

    const scaffolded = await runCli(["workflow", "scaffold", "--root", root, "--mode", "exploratory",
      "--output", join(root, "exploratory.json"), "--environment-file", join(root, "environment.json"),
      "--charter-file", join(root, "charter.json")], { cwd: root });
    expect(scaffolded.stderr).toBe("");
    expect(scaffolded.exitCode).toBe(ExitCode.SUCCESS);

    const run = await runCli(["workflow", "run", "--input", join(root, "exploratory.json")], { cwd: root });

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(ExitCode.SUCCESS);
    const result = JSON.parse(run.stdout) as WorkflowResult;
    expect(result).toMatchObject({ mode: "exploratory", outcome: "COMPLETED" });
    expect((await registeredArtifacts(root, result.runId)).some((artifact) => artifact.record.type === "exploration-charter")).toBe(true);
  }, 120_000);

  it("reaches regression mode end to end through the CLI", async () => {
    const root = await newRoot("regression");
    const planRunId = await regressionPlanningRun(root);
    await writeFile(join(root, "scope.json"), JSON.stringify({
      changes: [{ id: "CHG-1", requirementIds: ["REQ-REG"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }],
      provenance: { kind: "declared-change", reference: "PR-482" },
    }));

    const scaffolded = await runCli(["workflow", "scaffold", "--root", root, "--mode", "regression",
      "--output", join(root, "regression.json"), "--source-root", root, "--source-run-id", planRunId,
      "--change-scope-file", join(root, "scope.json")], { cwd: root });
    expect(scaffolded.stderr).toBe("");
    expect(scaffolded.exitCode).toBe(ExitCode.SUCCESS);

    const run = await runCli(["workflow", "run", "--input", join(root, "regression.json")], { cwd: root });

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(ExitCode.SUCCESS);
    const result = JSON.parse(run.stdout) as WorkflowResult;
    expect(result).toMatchObject({ mode: "regression", outcome: "COMPLETED" });
    const artifacts = await registeredArtifacts(root, result.runId);
    const selection = artifacts.find((artifact) => artifact.record.type === "regression-selection");
    expect(selection?.value).toMatchObject({
      selected: [{ testCaseId: "TC-REG-INCLUDED", revisionId: "REV-REG-INCLUDED" }],
      excluded: [{ testCaseId: "TC-REG-EXCLUDED", revisionId: "REV-REG-EXCLUDED" }],
    });
    // Exactly the selected case was driven: the excluded case's plan is `human-review` and unapproved,
    // so a selection that leaked it would have paused this run rather than completing it.
    const results = artifacts.filter((artifact) => artifact.record.type === "test-result");
    expect(results).toHaveLength(1);
    expect(results[0]?.value.testCaseId).toBe("TC-REG-INCLUDED");
  }, 120_000);

  it("reaches retest mode end to end through the CLI", async () => {
    const root = await newRoot("retest");
    // TWO source runs, and this is a consequence of the design rather than a fixture quirk: scaffold's
    // bundle path (src/cli/workflow.ts) refuses a run holding non-planning artifacts, so the run holding
    // the bug cannot also supply the bundle. They are matched by identity triple, not by artifact id,
    // and `--bug-run-id` resolves under `--root` rather than `--source-root`.
    const identity: Identity = { testCaseId: "TC-RETEST", revisionId: "REV-RETEST", instanceId: "INSTANCE-RETEST" };
    const planRunId = await planningRun(root, identity, "REQ-RETEST");
    const bug = await bugRun(root, identity, "REQ-RETEST");
    await writeFile(join(root, "scope.json"), JSON.stringify({
      changes: [{ id: "CHG-RETEST", requirementIds: ["REQ-RETEST"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }],
      provenance: { kind: "declared-change", reference: "PR-901" },
    }));

    const scaffolded = await runCli(["workflow", "scaffold", "--root", root, "--mode", "retest",
      "--output", join(root, "retest.json"), "--source-root", root, "--source-run-id", planRunId,
      "--bug-run-id", bug.runId, "--change-scope-file", join(root, "scope.json")], { cwd: root });
    expect(scaffolded.stderr).toBe("");
    expect(scaffolded.exitCode).toBe(ExitCode.SUCCESS);

    const run = await runCli(["workflow", "run", "--input", join(root, "retest.json")], { cwd: root });

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(ExitCode.SUCCESS);
    const result = JSON.parse(run.stdout) as WorkflowResult;
    expect(result).toMatchObject({ mode: "retest", outcome: "COMPLETED" });
    const retest = (await registeredArtifacts(root, result.runId)).find((artifact) => artifact.record.type === "retest-result");
    expect(retest?.value).toMatchObject({ sourceRunId: bug.runId, sourceBugArtifactId: bug.bugArtifactId, verdict: "FIXED" });
  }, 120_000);
});

/** A committed Playwright project in its own git repository, with this repository's runner linked in.
 *  Lifted from tests/e2e/lane2-batch-credited-run.test.ts, which is where the tagged-spec fixture the
 *  real `execute playwright` path uses actually lives. */
async function newObservedProject(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await newRoot("two-lane");
  await runFile("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  await appendFile(join(root, ".git", "config"), ["[user]", "\temail = observed@example.test", "\tname = Observed Test", "[commit]", "\tgpgsign = false", "[core]", "\tautocrlf = false", ""].join("\n"));
  for (const [relativePath, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, relativePath)), { recursive: true });
    await writeFile(join(root, relativePath), contents);
  }
  await runFile("git", ["add", "-A"], { cwd: root });
  await runFile("git", ["commit", "-q", "-m", "reviewed suite"], { cwd: root });
  // `runObservedPlaywright` resolves the runner BEFORE the anchor, so without a real install the run
  // would refuse with OBSERVED_RUNNER_MISSING and prove nothing about the two lanes.
  await symlink(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}

const observedIdentity: Identity = { testCaseId: "TC-OBSERVED", revisionId: "REV-OBSERVED", instanceId: "INSTANCE-OBSERVED" };
const drivenIdentity: Identity = { testCaseId: "TC-DRIVEN", revisionId: "REV-DRIVEN", instanceId: "INSTANCE-DRIVEN" };

/**
 * The terminal `plan` run the two-lane regression imports: one requirement, one auto-approved plan, and
 * two canonical cases the change scope both selects.
 *
 * `TC-OBSERVED`'s plan entry deliberately declares NO `browserExecution`. Lane 2 covers it, so the
 * residual must never reach it — and if the residual ever stopped subtracting what lane 2 observed,
 * `loadCanonicalTestCase` (src/operations/execute-browser-test.ts) would refuse the case outright rather
 * than quietly driving a second execution of something already observed.
 */
async function twoLanePlanningRun(root: string): Promise<string> {
  const source = await RunWorkspace.create({ root, mode: "plan", environmentProfile: environment });
  const execution = dsl();
  const requirement = await source.registerArtifactValue({ type: "requirement-analysis", relationships: [], value: {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-LANE",
    statements: [{ requirementId: "REQ-LANE", sourceProvenance: { kind: "user", reference: "phase8b-task5" }, normalizedText: "Member must be able to save an email, and the ledger must balance.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] }],
  } });
  const plan = await source.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-LANE", approvalPolicy: { mode: "auto-approve-safe" },
    testCases: [
      {
        testCaseId: drivenIdentity.testCaseId, title: "Save email",
        expectedResults: [{ id: "ER-DRIVEN", requirementId: "REQ-LANE", authority: "AUTHORITATIVE", text: "Saved" }],
        steps: [{ id: "plan-open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [],
        browserExecution: { revisionId: drivenIdentity.revisionId, instanceId: drivenIdentity.instanceId, browserDsl: execution, browserDslFingerprint: sha256Fingerprint(execution) },
      },
      {
        testCaseId: observedIdentity.testCaseId, title: "The ledger balances",
        expectedResults: [{ id: "ER-OBSERVED", requirementId: "REQ-LANE", authority: "AUTHORITATIVE", text: "The ledger balances" }],
        steps: [{ id: "plan-call", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [],
      },
    ],
  } });
  await source.registerArtifactValue({ type: "test-case", relationships: [plan.id], value: {
    artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", ...drivenIdentity,
    title: "Save email", steps: [{ id: "plan-open", action: "navigate", sideEffect: "none" }],
    coverage: { requirementId: "REQ-LANE", role: "member", behavior: "save email", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
  } });
  await source.registerArtifactValue({ type: "test-case", relationships: [plan.id], value: {
    artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", ...observedIdentity,
    title: "The ledger balances", steps: [{ id: "plan-call", action: "navigate", sideEffect: "none" }],
    coverage: { requirementId: "REQ-LANE", role: "member", behavior: "balance the ledger", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "The ledger balances" },
  } });
  await source.registerArtifactValue({ type: "coverage-obligation", relationships: [requirement.id], value: {
    artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0",
    obligationId: "COV-LANE-BROWSER", requirementAnalysisArtifactId: requirement.id, requirementId: "REQ-LANE",
    role: "member", behavior: "save email", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 },
    accessibilityMethod: null, risk: "low", required: true, outcome: "Saved",
  } });
  await source.registerArtifactValue({ type: "coverage-obligation", relationships: [requirement.id], value: {
    artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0",
    obligationId: "COV-LANE-API", requirementAnalysisArtifactId: requirement.id, requirementId: "REQ-LANE",
    role: "member", behavior: "balance the ledger", executionSurface: "api",
    accessibilityMethod: null, risk: "low", required: true, outcome: "The ledger balances",
  } });
  await source.finalize("plan");
  const runId = source.runId;
  await source.close();
  return runId;
}

describe("the two-lane filtered flow, end to end through the CLI", () => {
  it("pauses a regression run at exit 2, credits a real observed batch, and resumes driving only the residual", async () => {
    const root = await newObservedProject({
      ".gitignore": "node_modules/\nqa-results/\n",
      "playwright.config.js": "export default { testDir: './specs' };\n",
      "specs/ledger.spec.js": [
        "import { test, expect } from '@playwright/test';",
        `test('the ledger balances [qa:${observedIdentity.testCaseId}/${observedIdentity.revisionId}/${observedIdentity.instanceId}@api]', () => {`,
        "  expect(1 + 1).toBe(2);",
        "});",
        "",
      ].join("\n"),
    });
    const planRunId = await twoLanePlanningRun(root);
    await writeFile(join(root, "scope.json"), JSON.stringify({
      changes: [{ id: "CHG-LANE", requirementIds: ["REQ-LANE"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }],
      provenance: { kind: "declared-change", reference: "PR-8b" },
    }));

    const scaffolded = await runCli(["workflow", "scaffold", "--root", root, "--mode", "regression",
      "--output", join(root, "regression.json"), "--source-root", root, "--source-run-id", planRunId,
      "--change-scope-file", join(root, "scope.json")], { cwd: root });
    expect(scaffolded.stderr).toBe("");
    expect(scaffolded.exitCode).toBe(ExitCode.SUCCESS);
    // `observedExecution` is declared on the input file rather than by a scaffold flag: `workflow
    // scaffold` has none, and the field is inside `workflowInputChecksum`
    // (src/operations/run-workflow.ts), so the resume below must carry it byte-identically or
    // `checkpointWorkflow` refuses the resume.
    const scaffoldedInput = JSON.parse(await readFile(join(root, "regression.json"), "utf8")) as Record<string, unknown>;
    const pausedInput = { ...scaffoldedInput, observedExecution: { expected: true } };
    await writeFile(join(root, "paused.json"), `${JSON.stringify(pausedInput, null, 2)}\n`);

    const paused = await runCli(["workflow", "run", "--input", join(root, "paused.json")], { cwd: root });

    expect(paused.stderr).toBe("");
    expect(paused.exitCode).toBe(ExitCode.BLOCKED);
    const pausedResult = JSON.parse(paused.stdout) as WorkflowResult;
    expect(pausedResult.outcome).toBe("AWAITING_OBSERVED_EXECUTION");
    expect(pausedResult.pendingObservedExecution).toMatchObject({ operation: "execute-browser-test", command: "execute playwright" });
    // The selection ran and nothing was driven: the pause is in front of execution, not after it.
    const pausedArtifacts = await registeredArtifacts(root, pausedResult.runId);
    expect(pausedArtifacts.some((artifact) => artifact.record.type === "regression-selection")).toBe(true);
    expect(pausedArtifacts.filter((artifact) => artifact.record.type === "test-result")).toHaveLength(0);

    const executed = await runCli(["execute", "playwright", "--root", root, "--run-id", pausedResult.runId, "--spec-dir", "specs", "--", "--workers=1"], { cwd: root });

    expect(executed.stderr).toBe("");
    expect(executed.exitCode).toBe(ExitCode.SUCCESS);
    const execution = JSON.parse(executed.stdout) as { entryCount: number; excluded: unknown[]; exitCode: number; runnerWorkingDir: string };
    expect(execution).toMatchObject({ entryCount: 1, excluded: [], exitCode: 0 });
    // The runner's own working directory lives in the OS temp dir, outside `root`, and is deliberately
    // left behind as the operator's escape hatch to the verbatim report (see
    // src/operations/execute-observed-playwright.ts). Removed by exact path rather than by scanning for
    // a `qa-skills-observed-` prefix, so a concurrent suite's directory can never be caught by this.
    roots.push(execution.runnerWorkingDir);

    await writeFile(join(root, "resume.json"), `${JSON.stringify({ ...pausedInput, resumeRunId: pausedResult.runId }, null, 2)}\n`);

    const resumed = await runCli(["workflow", "run", "--input", join(root, "resume.json")], { cwd: root });

    expect(resumed.stderr).toBe("");
    expect(resumed.exitCode).toBe(ExitCode.SUCCESS);
    const resumedResult = JSON.parse(resumed.stdout) as WorkflowResult;
    expect(resumedResult.runId).toBe(pausedResult.runId);
    expect(resumedResult.outcome).toBe("COMPLETED");

    const artifacts = await registeredArtifacts(root, pausedResult.runId);
    const selection = artifacts.find((artifact) => artifact.record.type === "regression-selection");
    expect((selection?.value.selected as readonly { testCaseId: string }[]).map((decision) => decision.testCaseId).sort())
      .toEqual([drivenIdentity.testCaseId, observedIdentity.testCaseId]);
    // The residual, and the whole point of the phase: both cases were selected, lane 2 observed one, and
    // the resume drove ONLY the other.
    const results = artifacts.filter((artifact) => artifact.record.type === "test-result");
    expect(results).toHaveLength(1);
    expect(results[0]?.value.testCaseId).toBe(drivenIdentity.testCaseId);
    expect(artifacts.filter((artifact) => artifact.record.type === "test-result-batch")).toHaveLength(1);

    const validated = await runCli(["validate", "--root", root, "--run-id", pausedResult.runId], { cwd: root });
    expect(validated.exitCode).toBe(ExitCode.SUCCESS);
    expect(JSON.parse(validated.stdout)).toMatchObject({ valid: true, diagnostics: [] });
  }, 300_000);
});
