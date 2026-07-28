import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { createQaTester, type CanonicalPlanBundleRef, type WorkflowResult } from "../../src/operations/run-workflow.js";
import { sha256Fingerprint } from "../../src/planning/testcase-revision.js";
import { TestDataHookRegistry } from "../../src/test-data/hooks.js";
import { serveBrowserFixture } from "../../fixtures/browser/server.js";

/**
 * `AWAITING_HUMAN_INPUT` (Task 37) — the run stops in front of the operation that would otherwise
 * throw or snapshot a dishonest gate, and waits for a person.
 *
 * Two commands write artifacts only a person can supply — `qa-skill approval record` and
 * `qa-skill attestation record` — and before this task neither had a reachable position in any run
 * that produces a release gate. These tests pin the seam: WHERE the run stops, that stopping is not
 * a failure, that re-entry is idempotent, and — the load-bearing half — that an obligation nothing
 * can ever satisfy does NOT stop the run but reaches the gate as `NOT_READY`.
 */

const roots: string[] = [];
const environment = {
  artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0",
  environmentProfileId: "ENV-HUMAN", name: "Human input fixture", classification: "test",
  baseUrl: "http://127.0.0.1", productionReadOnly: false,
} as const;
const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "../../fixtures/browser/basic.html");
let browser: Browser;
let baseUrl: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  const server = await serveBrowserFixture(fixture);
  baseUrl = server.baseUrl;
  closeServer = () => server.close();
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser.close(); await closeServer(); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

type ObligationSpec = Readonly<{
  obligationId: string;
  requirementId?: string;
  executionSurface: "browser" | "api" | "manual";
  accessibilityMethod: "automated-analysis" | "keyboard" | "screen-reader" | "cognitive-manual" | null;
  required?: boolean;
  behavior?: string;
  outcome?: string;
}>;

type BundleOptions = Readonly<{
  approvalPolicy?: "auto-approve-safe" | "human-review";
  obligations?: readonly ObligationSpec[];
}>;

function dsl() {
  return { steps: [
    { id: "open", action: { kind: "open", url: baseUrl }, sideEffect: "none" },
    { id: "fill", action: { kind: "fill", locator: { label: "Email" }, value: "qa@example.test" }, assertions: [{ kind: "value", locator: { label: "Email" }, value: "qa@example.test" }], sideEffect: "none" },
    { id: "save", action: { kind: "click", locator: { role: "button", name: "Save" } }, assertions: [{ kind: "text", locator: { testId: "result" }, text: "Saved" }], sideEffect: "none" },
  ] } as const;
}

/** The browser obligation every fixture carries, so a run with no human obligation still gates READY. */
const browserObligation: ObligationSpec = { obligationId: "COV-BROWSER", executionSurface: "browser", accessibilityMethod: null };

/**
 * A terminal `plan` run holding one authoritative requirement (`REQ-HUMAN`), one non-authoritative
 * one (`REQ-ASSUMED`, referenced by no plan entry), the plan, its canonical test case, and the
 * requested obligations — returned as the checksum-bound bundle a `full` run imports.
 */
async function planBundle(root: string, options: BundleOptions = {}): Promise<CanonicalPlanBundleRef> {
  const source = await RunWorkspace.create({ root, mode: "plan", environmentProfile: environment });
  const requirement = await source.registerArtifactValue({ type: "requirement-analysis", relationships: [], value: {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-HUMAN",
    statements: [
      { requirementId: "REQ-HUMAN", sourceProvenance: { kind: "user", reference: "task-37" }, normalizedText: "Member must be able to save an email.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] },
      { requirementId: "REQ-ASSUMED", sourceProvenance: { kind: "user", reference: "task-37" }, normalizedText: "Saving an email is assumed to be announced to assistive technology.", authority: "ASSUMED", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] },
    ],
  } });
  const execution = dsl();
  const plan = await source.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-HUMAN",
    approvalPolicy: { mode: options.approvalPolicy ?? "auto-approve-safe" },
    testCases: [{
      testCaseId: "TC-HUMAN", title: "Save email",
      expectedResults: [{ id: "ER-HUMAN", requirementId: "REQ-HUMAN", authority: "AUTHORITATIVE", text: "Saved" }],
      steps: [{ id: "plan-open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [],
      browserExecution: { revisionId: "REV-HUMAN", instanceId: "INSTANCE-HUMAN", browserDsl: execution, browserDslFingerprint: sha256Fingerprint(execution) },
    }],
  } });
  const testcase = await source.registerArtifactValue({ type: "test-case", relationships: [plan.id], value: {
    artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", testCaseId: "TC-HUMAN", revisionId: "REV-HUMAN", instanceId: "INSTANCE-HUMAN",
    title: "Save email", steps: [{ id: "plan-open", action: "navigate", sideEffect: "none" }],
    coverage: { requirementId: "REQ-HUMAN", role: "member", behavior: "save email", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
  } });
  const obligations = await Promise.all((options.obligations ?? [browserObligation]).map((spec) => source.registerArtifactValue({
    type: "coverage-obligation", relationships: [requirement.id], value: {
      artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0",
      obligationId: spec.obligationId, requirementAnalysisArtifactId: requirement.id, requirementId: spec.requirementId ?? "REQ-HUMAN",
      role: "member", behavior: spec.behavior ?? "save email", executionSurface: spec.executionSurface,
      ...(spec.executionSurface === "browser" ? { browser: "chromium", viewport: { width: 1280, height: 720 } } : {}),
      accessibilityMethod: spec.accessibilityMethod, risk: "low", required: spec.required ?? true, outcome: spec.outcome ?? "Saved",
    },
  })));
  await source.finalize("plan");
  const records = await Promise.all([requirement, plan, testcase, ...obligations].map((artifact) => source.readArtifactRecord(artifact.id)));
  await source.close();
  return { sourceRunId: source.runId, artifacts: records.map((artifact) => ({ artifactId: artifact.id, sha256: artifact.sha256 })) };
}

function tester() {
  return createQaTester({
    browserManagers: { chromium: { browser } },
    testDataRegistries: { trusted: new TestDataHookRegistry([], {}) },
    evidencePolicies: { required: { safety: { screenshot: "required", console: "required", network: "off", logs: "required" } } },
  });
}

function fullInput(root: string, bundle: CanonicalPlanBundleRef, resumeRunId?: string) {
  return {
    root, mode: "full" as const, environmentProfile: environment, bundle,
    ...(resumeRunId === undefined ? {} : { resumeRunId }),
    runtime: { browserManagerId: "chromium", testDataRegistryId: "trusted", evidencePolicyId: "required" },
  };
}

/**
 * A terminal `plan` run for `regression` mode: two independent plans sharing one requirement, each
 * holding one canonical test case. `PLAN-REG-INCLUDED` is `auto-approve-safe`; its case declares no
 * `regressionIndex`, so its index falls back to the requirement its `coverage` names (matching the one
 * declared change) and a regression selection keeps it. `PLAN-REG-EXCLUDED` is `human-review` and
 * unapproved; its case declares an explicit `regressionIndex` that maps to nothing declared, so the
 * same selection excludes it even though both cases cover the same requirement.
 *
 * `regression` is the only mode where `executionCaseIds` is narrowed by an in-loop operation
 * (`select-regression`) rather than being fixed before the loop by `ensureCanonicalBundle` — see
 * `pendingHumanInput`'s docblock. This bundle exercises exactly that: the approval guard must evaluate
 * over the SELECTED set at `execute-browser-test`, never over the superset of every imported case.
 */
async function regressionBundleWithExcludedHumanReviewPlan(root: string): Promise<CanonicalPlanBundleRef> {
  const source = await RunWorkspace.create({ root, mode: "plan", environmentProfile: environment });
  const requirement = await source.registerArtifactValue({ type: "requirement-analysis", relationships: [], value: {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-REG",
    statements: [
      { requirementId: "REQ-REG", sourceProvenance: { kind: "user", reference: "task-37-finding-5" }, normalizedText: "Member must be able to save an email.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] },
    ],
  } });
  const execution = dsl();
  const includedPlan = await source.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-REG-INCLUDED",
    approvalPolicy: { mode: "auto-approve-safe" },
    testCases: [{
      testCaseId: "TC-REG-INCLUDED", title: "Save email (selected by regression)",
      expectedResults: [{ id: "ER-REG-INCLUDED", requirementId: "REQ-REG", authority: "AUTHORITATIVE", text: "Saved" }],
      steps: [{ id: "plan-open-included", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [],
      browserExecution: { revisionId: "REV-REG-INCLUDED", instanceId: "INSTANCE-REG-INCLUDED", browserDsl: execution, browserDslFingerprint: sha256Fingerprint(execution) },
    }],
  } });
  const excludedPlan = await source.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-REG-EXCLUDED",
    approvalPolicy: { mode: "human-review" },
    testCases: [{
      testCaseId: "TC-REG-EXCLUDED", title: "Save email (excluded by regression)",
      expectedResults: [{ id: "ER-REG-EXCLUDED", requirementId: "REQ-REG", authority: "AUTHORITATIVE", text: "Saved" }],
      steps: [{ id: "plan-open-excluded", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [],
      browserExecution: { revisionId: "REV-REG-EXCLUDED", instanceId: "INSTANCE-REG-EXCLUDED", browserDsl: execution, browserDslFingerprint: sha256Fingerprint(execution) },
    }],
  } });
  const includedCase = await source.registerArtifactValue({ type: "test-case", relationships: [includedPlan.id], value: {
    artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", testCaseId: "TC-REG-INCLUDED", revisionId: "REV-REG-INCLUDED", instanceId: "INSTANCE-REG-INCLUDED",
    title: "Save email (selected by regression)", steps: [{ id: "plan-open-included", action: "navigate", sideEffect: "none" }],
    coverage: { requirementId: "REQ-REG", role: "member", behavior: "save email", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
  } });
  const excludedCase = await source.registerArtifactValue({ type: "test-case", relationships: [excludedPlan.id], value: {
    artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", testCaseId: "TC-REG-EXCLUDED", revisionId: "REV-REG-EXCLUDED", instanceId: "INSTANCE-REG-EXCLUDED",
    title: "Save email (excluded by regression)", steps: [{ id: "plan-open-excluded", action: "navigate", sideEffect: "none" }],
    coverage: { requirementId: "REQ-REG", role: "member", behavior: "save email, excluded", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
    // Explicit and empty/unmatched, so the default requirement-fallback in `regressionCaseFromCanonical`
    // does not apply: this instance shares `REQ-REG` with the included case (one obligation covers both)
    // but maps to no declared change, so `selectRegressionCases` excludes it regardless. It is never
    // added to `executionCaseIds`, and the approval guard must never see its pending plan.
    regressionIndex: { requirementIds: [], codeSurfaces: ["excluded-surface"], declaredDependencies: [], gitPaths: [], userScope: [] },
  } });
  const obligation = await source.registerArtifactValue({ type: "coverage-obligation", relationships: [requirement.id], value: {
    artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0",
    obligationId: "COV-REG", requirementAnalysisArtifactId: requirement.id, requirementId: "REQ-REG",
    role: "member", behavior: "save email", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 },
    accessibilityMethod: null, risk: "low", required: true, outcome: "Saved",
  } });
  await source.finalize("plan");
  const records = await Promise.all([requirement, includedPlan, excludedPlan, includedCase, excludedCase, obligation].map((artifact) => source.readArtifactRecord(artifact.id)));
  await source.close();
  return { sourceRunId: source.runId, artifacts: records.map((artifact) => ({ artifactId: artifact.id, sha256: artifact.sha256 })) };
}

function regressionTester() {
  return createQaTester({
    browserManagers: { chromium: { browser } },
    evidencePolicies: { required: { safety: { screenshot: "required", console: "required", network: "off", logs: "required" } } },
    changeScopeSources: { trusted: {
      changes: [{ id: "CHANGE-REG-INCLUDED", requirementIds: ["REQ-REG"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }],
      provenance: { kind: "git-diff", reference: "task-37-finding-5" },
    } },
  });
}

function regressionInput(root: string, bundle: CanonicalPlanBundleRef) {
  return {
    root, mode: "regression" as const, environmentProfile: environment, bundle,
    runtime: { browserManagerId: "chromium", evidencePolicyId: "required", changeScopeSourceId: "trusted" },
  };
}

async function registeredArtifacts(root: string, runId: string) {
  const workspace = await RunWorkspace.open(root, runId);
  try { return await workspace.readRegisteredArtifacts(); } finally { await workspace.close(); }
}

async function runStatus(root: string, runId: string): Promise<string> {
  return String((JSON.parse(await readFile(join(root, "qa-results", runId, "run-metadata.json"), "utf8")) as { status: string }).status);
}

/** Writes a `qa-skill workflow run --input` file; the CLI supplies the local browser and data registries. */
async function inputFile(root: string, name: string, bundle: CanonicalPlanBundleRef, resumeRunId?: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `${JSON.stringify({ root, mode: "full", environmentProfile: environment, bundle, ...(resumeRunId === undefined ? {} : { resumeRunId }) }, null, 2)}\n`);
  return path;
}

describe("approval: a human-review plan pauses instead of throwing", () => {
  it("records the approval and resumes to a completed run entirely through the CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-human-approval-cli-")); roots.push(root);
    const bundle = await planBundle(root, { approvalPolicy: "human-review" });

    const paused = await runCli(["workflow", "run", "--input", await inputFile(root, "run.json", bundle)], { cwd: root });

    expect(paused.stderr).toBe("");
    expect(paused.exitCode).toBe(ExitCode.BLOCKED);
    const pausedResult = JSON.parse(paused.stdout) as WorkflowResult;
    expect(pausedResult.outcome).toBe("AWAITING_HUMAN_INPUT");
    const plan = (await registeredArtifacts(root, pausedResult.runId)).find((artifact) => artifact.record.type === "test-plan");
    if (!plan) throw new Error("Expected an imported test plan");
    expect(pausedResult.pendingHumanInput).toEqual({
      kind: "approval",
      operation: "execute-browser-test",
      command: "approval record",
      reason: "Execution requires a human approval decision for a human-review test plan.",
      subjects: [{ artifactId: plan.record.id, sha256: plan.record.sha256, reference: plan.record.id }],
    });
    // A pause is not a failure: no gate was snapshotted, nothing executed, and the run is still open.
    const pausedArtifacts = await registeredArtifacts(root, pausedResult.runId);
    expect(pausedArtifacts.some((artifact) => artifact.record.type === "release-gate")).toBe(false);
    expect(pausedArtifacts.some((artifact) => artifact.record.type === "test-result")).toBe(false);
    expect(pausedArtifacts.some((artifact) => artifact.record.type === "workflow-checkpoint")).toBe(true);
    expect(await runStatus(root, pausedResult.runId)).not.toMatch(/COMPLETED|BLOCKED|ABORTED/);

    // The workspace is still writable, which is the whole point of not finalizing.
    const recorded = await runCli([
      "approval", "record", "--root", root, "--run-id", pausedResult.runId,
      "--plan-artifact-id", plan.record.id, "--approved-by", "qa-lead@example.test",
    ], { cwd: root });
    expect(recorded.stderr).toBe("");
    expect(recorded.exitCode).toBe(ExitCode.SUCCESS);

    const resumed = await runCli(["workflow", "run", "--input", await inputFile(root, "resume.json", bundle, pausedResult.runId)], { cwd: root });

    expect(resumed.stderr).toBe("");
    expect(resumed.exitCode).toBe(ExitCode.SUCCESS);
    const resumedResult = JSON.parse(resumed.stdout) as WorkflowResult;
    expect(resumedResult.runId).toBe(pausedResult.runId);
    expect(resumedResult.outcome).toBe("COMPLETED");
    expect(resumedResult.releaseRecommendation).toBe("READY");
    expect(resumedResult.pendingHumanInput).toBeUndefined();
    const finalArtifacts = await registeredArtifacts(root, pausedResult.runId);
    expect(finalArtifacts.filter((artifact) => artifact.record.type === "test-result")).toHaveLength(1);
    expect(finalArtifacts.filter((artifact) => artifact.record.type === "release-gate")).toHaveLength(1);
  }, 120_000);

  it("pauses again on a resume that still has no approval, without executing or double-registering", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-human-approval-reentry-")); roots.push(root);
    const bundle = await planBundle(root, { approvalPolicy: "human-review" });
    const run = tester();

    const first = await run(fullInput(root, bundle));
    expect(first.outcome).toBe("AWAITING_HUMAN_INPUT");
    const before = await registeredArtifacts(root, first.runId);

    const second = await run(fullInput(root, bundle, first.runId));

    expect(second.runId).toBe(first.runId);
    expect(second.outcome).toBe("AWAITING_HUMAN_INPUT");
    expect(second.pendingHumanInput).toEqual(first.pendingHumanInput);
    // Nothing new was registered: the guarded operation neither ran nor advanced its checkpoint.
    const after = await registeredArtifacts(root, first.runId);
    expect(after.map((artifact) => artifact.record.id)).toEqual(before.map((artifact) => artifact.record.id));
    expect(after.some((artifact) => artifact.record.type === "test-result" || artifact.record.type === "release-gate")).toBe(false);
  }, 120_000);
});

describe("attestation: a required manual accessibility obligation pauses before the gate", () => {
  it("pauses before generate-qa-report, then credits the recorded attestation on resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-human-attestation-")); roots.push(root);
    const bundle = await planBundle(root, { obligations: [
      browserObligation,
      { obligationId: "COV-A11Y", executionSurface: "manual", accessibilityMethod: "keyboard", behavior: "save email with the keyboard alone", outcome: "Saved" },
    ] });
    const run = tester();

    const paused = await run(fullInput(root, bundle));

    expect(paused.outcome).toBe("AWAITING_HUMAN_INPUT");
    const obligation = (await registeredArtifacts(root, paused.runId)).find((artifact) => artifact.record.type === "coverage-obligation" && artifact.value.obligationId === "COV-A11Y");
    if (!obligation) throw new Error("Expected an imported accessibility obligation");
    expect(paused.pendingHumanInput).toEqual({
      kind: "attestation",
      operation: "generate-qa-report",
      command: "attestation record",
      reason: "The release gate requires a Human Attestation for a required manual accessibility obligation.",
      subjects: [{ artifactId: obligation.record.id, sha256: obligation.record.sha256, reference: "COV-A11Y", method: "keyboard" }],
    });
    // The attempt already ran — the pause is in front of the gate, not in front of execution.
    const pausedArtifacts = await registeredArtifacts(root, paused.runId);
    expect(pausedArtifacts.filter((artifact) => artifact.record.type === "test-result")).toHaveLength(1);
    expect(pausedArtifacts.some((artifact) => artifact.record.type === "release-gate" || artifact.record.type === "qa-execution-report")).toBe(false);

    const recorded = await runCli([
      "attestation", "record", "--root", root, "--run-id", paused.runId,
      "--obligation-id", "COV-A11Y", "--method", "keyboard", "--attested-by", "reviewer@example.test",
      "--statement", "Completed the save-email flow with the keyboard alone; every control was reachable and focus stayed visible.",
    ], { cwd: root });
    expect(recorded.stderr).toBe("");
    expect(recorded.exitCode).toBe(ExitCode.SUCCESS);

    const resumed = await run(fullInput(root, bundle, paused.runId));

    expect(resumed.runId).toBe(paused.runId);
    expect(resumed.outcome).toBe("COMPLETED");
    expect(resumed.releaseRecommendation).toBe("READY");
    const gate = (await registeredArtifacts(root, paused.runId)).find((artifact) => artifact.record.type === "release-gate");
    const ruleInputs = gate?.value.ruleInputs as { coverage: { requiredMissing: string[] } };
    expect(ruleInputs.coverage.requiredMissing).toEqual([]);
    // Exactly one attempt: the resume rehydrated execute-browser-test rather than re-running it.
    expect((await registeredArtifacts(root, paused.runId)).filter((artifact) => artifact.record.type === "test-result")).toHaveLength(1);
  }, 120_000);

  it.each([
    ["an execution surface no executor covers", { obligationId: "COV-API", executionSurface: "api", accessibilityMethod: null }, "COV-API"],
    ["an automated accessibility analysis no scanner performs", { obligationId: "COV-AUTO", executionSurface: "manual", accessibilityMethod: "automated-analysis" }, "COV-AUTO"],
    ["a manual evaluation of a non-authoritative requirement", { obligationId: "COV-ASSUMED", executionSurface: "manual", accessibilityMethod: "keyboard", requirementId: "REQ-ASSUMED", behavior: "announce the save" }, "COV-ASSUMED"],
  ] as const)("does not pause for %s — it reaches the gate as NOT_READY", async (_label, spec, obligationId) => {
    const root = await mkdtemp(join(tmpdir(), "qa-human-unsatisfiable-")); roots.push(root);
    const bundle = await planBundle(root, { obligations: [browserObligation, spec] });

    const result = await tester()(fullInput(root, bundle));

    expect(result.outcome).not.toBe("AWAITING_HUMAN_INPUT");
    expect(result.pendingHumanInput).toBeUndefined();
    expect(result.releaseRecommendation).toBe("NOT_READY");
    const gate = (await registeredArtifacts(root, result.runId)).find((artifact) => artifact.record.type === "release-gate");
    const ruleInputs = gate?.value.ruleInputs as { coverage: { requiredMissing: string[] } };
    expect(ruleInputs.coverage.requiredMissing).toEqual([obligationId]);
  }, 120_000);

  it("does not pause when two registered obligations share the obligationId the command would name", async () => {
    // Nothing enforces `obligationId` uniqueness across a workspace, and `recordHumanAttestation`
    // refuses unless exactly one registered obligation carries the id it is given. Pausing here would
    // name a command that cannot run, so both stay explicitly unmet at the gate instead.
    const root = await mkdtemp(join(tmpdir(), "qa-human-ambiguous-")); roots.push(root);
    const bundle = await planBundle(root, { obligations: [
      browserObligation,
      { obligationId: "COV-A11Y", executionSurface: "manual", accessibilityMethod: "keyboard", behavior: "save email with the keyboard alone" },
      { obligationId: "COV-A11Y", executionSurface: "manual", accessibilityMethod: "keyboard", behavior: "reach the save button with the keyboard alone" },
    ] });

    const result = await tester()(fullInput(root, bundle));

    expect(result.outcome).not.toBe("AWAITING_HUMAN_INPUT");
    expect(result.pendingHumanInput).toBeUndefined();
    expect(result.releaseRecommendation).toBe("NOT_READY");
    const recorded = await runCli([
      "attestation", "record", "--root", root, "--run-id", result.runId,
      "--obligation-id", "COV-A11Y", "--method", "keyboard", "--attested-by", "reviewer@example.test",
      "--statement", "Completed the save-email flow with the keyboard alone; every control was reachable.",
    ], { cwd: root });
    expect(recorded.stderr).toMatch(/exactly one registered coverage obligation/);
  }, 120_000);

  it("does not pause for an optional manual obligation — an optional gap is READY_WITH_RISKS, not a stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-human-optional-")); roots.push(root);
    const bundle = await planBundle(root, { obligations: [
      browserObligation,
      { obligationId: "COV-OPTIONAL", executionSurface: "manual", accessibilityMethod: "keyboard", required: false, behavior: "save email with the keyboard alone" },
    ] });

    const result = await tester()(fullInput(root, bundle));

    expect(result.outcome).toBe("COMPLETED");
    expect(result.pendingHumanInput).toBeUndefined();
    expect(result.releaseRecommendation).toBe("READY_WITH_RISKS");
  }, 120_000);
});

describe("the common case", () => {
  it("runs an auto-approved plan with no human obligation straight through, unpaused", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-human-common-")); roots.push(root);
    const bundle = await planBundle(root);

    const result = await tester()(fullInput(root, bundle));

    expect(result.outcome).toBe("COMPLETED");
    expect(result.pendingHumanInput).toBeUndefined();
    expect(result.releaseRecommendation).toBe("READY");
    const runIds = await readdir(join(root, "qa-results"));
    expect(runIds).toHaveLength(2);
  }, 120_000);
});

describe("regression: the approval guard sees only what the selection kept", () => {
  it("does not pause for a human-review plan on a case the regression selection excludes", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-human-regression-excluded-")); roots.push(root);
    const bundle = await regressionBundleWithExcludedHumanReviewPlan(root);

    const result = await regressionTester()(regressionInput(root, bundle));

    // The load-bearing assertion: an unapproved `human-review` plan is registered in this workspace,
    // but it never pauses the run, because `select-regression` excluded its case before the approval
    // guard runs at `execute-browser-test`.
    expect(result.outcome).toBe("COMPLETED");
    expect(result.pendingHumanInput).toBeUndefined();
    expect(result.releaseRecommendation).toBe("READY");
    const artifacts = await registeredArtifacts(root, result.runId);
    const selection = artifacts.find((artifact) => artifact.record.type === "regression-selection");
    expect(selection?.value).toMatchObject({
      selected: [{ testCaseId: "TC-REG-INCLUDED", revisionId: "REV-REG-INCLUDED" }],
      excluded: [{ testCaseId: "TC-REG-EXCLUDED", revisionId: "REV-REG-EXCLUDED" }],
    });
    // Only the selected, auto-approved case ever reached `execute-browser-test`. If the excluded
    // case's plan had been considered, it would have paused (or, run directly, thrown) instead.
    expect(artifacts.filter((artifact) => artifact.record.type === "test-result")).toHaveLength(1);
  }, 120_000);
});
