import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";
import { bootstrapPlanningBundle, runLocalWorkflow, scaffoldWorkflowInput } from "../../src/cli/workflow.js";
import { QaSkillsError } from "../../src/core/errors.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { createEntityId } from "../../src/core/ids.js";
import { generateBugReport } from "../../src/operations/generate-bug-report.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const environment = { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "env", name: "Fixture", classification: "test", baseUrl: "https://fixture.test", productionReadOnly: false } as const;

// Shared identity triple: `planningOnlyRun` and `executedRunWithBug` deliberately register the SAME
// testCaseId/revisionId/instanceId across two distinct runs. Retest matches its bundle to the source
// scenarios by that exact triple (src/operations/run-workflow.ts), never by artifact ID, so a realistic
// fixture pair needs it even though the assertions in this file only inspect `scaffoldWorkflowInput`'s
// output.
const bugIdentity = { testCaseId: "TC-BUG", revisionId: "REV-BUG", instanceId: "INSTANCE-BUG", requirementId: "REQ-BUG" } as const;

/** A planning-only terminal run (mode "plan") carrying the given identity triple. Scaffold's bundle
 *  path refuses a source run holding non-planning artifacts (src/cli/workflow.ts), so a retest's
 *  bundle must come from a run like this one rather than from the executed run holding its bug. */
async function planningOnlyRun(root: string, envPath: string, identity: typeof bugIdentity): Promise<string> {
  const paths = {
    requirement: join(root, `requirement-${identity.testCaseId}.json`),
    plan: join(root, `plan-${identity.testCaseId}.json`),
    testcase: join(root, `testcase-${identity.testCaseId}.json`),
    coverage: join(root, `coverage-${identity.testCaseId}.json`),
  };
  const requirement = { artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: `RA-${identity.testCaseId}`, statements: [{ requirementId: identity.requirementId, sourceProvenance: { kind: "user", reference: "fixture" }, normalizedText: "Member must save.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] }] };
  const plan = { artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: `PLAN-${identity.testCaseId}`, approvalPolicy: { mode: "human-review" }, testCases: [{ testCaseId: identity.testCaseId, title: "Save", expectedResults: [{ id: "ER", requirementId: identity.requirementId, authority: "AUTHORITATIVE", text: "Saved" }], steps: [{ id: "open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [] }] };
  const testcase = { artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", testCaseId: identity.testCaseId, revisionId: identity.revisionId, instanceId: identity.instanceId, title: "Save", steps: [{ id: "open", action: "navigate", sideEffect: "none" }], coverage: { requirementId: identity.requirementId, role: "member", behavior: "save", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" } };
  const coverage = { artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0", obligationId: `COV-${identity.testCaseId}`, requirementAnalysisArtifactId: "replaced-atomically", requirementId: identity.requirementId, role: "member", behavior: "save", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved", required: true };
  await Promise.all([
    writeFile(paths.requirement, JSON.stringify(requirement)),
    writeFile(paths.plan, JSON.stringify(plan)),
    writeFile(paths.testcase, JSON.stringify(testcase)),
    writeFile(paths.coverage, JSON.stringify(coverage)),
  ]);
  const bootstrapped = await bootstrapPlanningBundle({ root, environmentPath: envPath, requirementPath: paths.requirement, planPath: paths.plan, testCasePaths: [paths.testcase], coveragePaths: [paths.coverage] });
  return bootstrapped.runId;
}

/** A terminal `execute` run holding one FAILED/PRODUCT_DEFECT test-result per identity and a generated
 *  `bug-report` for each. Lifted from the `options.sourceBug` half of `sourceBundle` in
 *  tests/orchestration/runtime-public.e2e.test.ts, trimmed to what `generateBugReport` requires: one
 *  registered environment, the attempt's testcase, the attempt itself, and evidence bound to it. */
async function executedRunWithBug(root: string, options: { bugs?: number } = {}): Promise<{ runId: string; bugArtifactId: string; bugSha256: string }> {
  const count = options.bugs ?? 1;
  const identities = Array.from({ length: count }, (_, index) => index === 0
    ? bugIdentity
    : { testCaseId: `TC-BUG-EXTRA-${index}`, revisionId: `REV-BUG-EXTRA-${index}`, instanceId: `INSTANCE-BUG-EXTRA-${index}`, requirementId: bugIdentity.requirementId });
  const source = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
  const requirement = await source.registerArtifactValue({ type: "requirement-analysis", relationships: [], value: {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-BUG",
    statements: [{ requirementId: bugIdentity.requirementId, sourceProvenance: { kind: "user", reference: "fixture" }, normalizedText: "Member must save.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] }],
  } });
  const plan = await source.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-BUG", approvalPolicy: { mode: "human-review" },
    testCases: identities.map((identity) => ({ testCaseId: identity.testCaseId, title: "Save", expectedResults: [{ id: `ER-${identity.testCaseId}`, requirementId: identity.requirementId, authority: "AUTHORITATIVE", text: "Saved" }], steps: [{ id: "open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [] })),
  } });
  let bugArtifactId = ""; let bugSha256 = "";
  for (const identity of identities) {
    const attemptId = `ATT-${identity.testCaseId}`;
    const testcase = await source.registerArtifactValue({ type: "test-case", relationships: [plan.id], value: {
      artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", testCaseId: identity.testCaseId, revisionId: identity.revisionId, instanceId: identity.instanceId, title: "Save", steps: [{ id: "open", action: "navigate", sideEffect: "none" }],
      coverage: { requirementId: identity.requirementId, role: "member", behavior: "save", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
    } });
    const attempt = await source.registerArtifactValue({ type: "test-result", relationships: [testcase.id], value: {
      artifactType: "test-result", schemaVersion: "2.0.0", producerVersion: "1.0.0", attemptId, runId: source.runId, testCaseId: identity.testCaseId, testCaseRevisionId: identity.revisionId, testCaseInstanceId: identity.instanceId,
      status: "FAILED", failureClassification: "PRODUCT_DEFECT", observedEngine: "chromium",
      steps: [{ stepId: "open", status: "FAILED", durationMs: 1 }],
      startedAt: "2026-07-23T00:00:00.000Z", finishedAt: "2026-07-23T00:01:00.000Z",
    } });
    await source.registerEvidenceBundle({
      binaries: [{ filename: `${identity.testCaseId}.txt`, contents: Buffer.from("failure"), mediaType: "text/plain", captureType: "log" }],
      relationships: [attempt.id],
      descriptor: (binaries) => ({
        artifactType: "evidence", schemaVersion: "3.0.0", producerVersion: "1.0.0", evidenceId: createEntityId(),
        runId: source.runId, subject: { kind: "attempt", attemptId, testCaseId: identity.testCaseId, testCaseRevisionId: identity.revisionId, testCaseInstanceId: identity.instanceId },
        kind: "log", capturedAt: "2026-07-23T00:01:00.000Z", sha256: binaries[0]!.sha256, relativePath: binaries[0]!.relativePath, mediaType: "text/plain",
        binaryArtifactIds: binaries.map((binary) => binary.id),
        binaryArtifacts: binaries.map((binary) => ({ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType })),
        telemetryFindings: [{ kind: "console" as const, level: "error", message: "failure" }],
        provenance: { captureType: "log" as const, url: environment.baseUrl, browser: "chromium", build: "fixture", capturedAt: "2026-07-23T00:01:00.000Z", testcaseId: identity.testCaseId },
      }),
    });
    const generated = await generateBugReport({ workspace: source, attemptId, unsafeRerunReason: "Fixture preserves a single captured production defect observation." });
    if (generated.kind !== "BUG") throw new Error("Expected a product bug report");
    bugArtifactId = generated.record.id; bugSha256 = generated.record.sha256;
  }
  await source.finalize("execute");
  const runId = source.runId;
  await source.close();
  return { runId, bugArtifactId, bugSha256 };
}

describe("workflow scaffold", () => {
  it("bootstraps the first complete terminal planning bundle from explicit canonical files", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-workflow-bootstrap-")); roots.push(root);
    const paths = {
      environment: join(root, "environment.json"),
      requirement: join(root, "requirement.json"),
      plan: join(root, "plan.json"),
      testcase: join(root, "testcase.json"),
      coverage: join(root, "coverage.json"),
    };
    const requirement = { artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA", statements: [{ requirementId: "REQ", sourceProvenance: { kind: "user", reference: "fixture" }, normalizedText: "User must save", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] }] };
    const plan = { artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN", approvalPolicy: { mode: "human-review" }, testCases: [{ testCaseId: "TC", title: "Save", expectedResults: [{ id: "ER", requirementId: "REQ", authority: "AUTHORITATIVE", text: "Saved" }], steps: [{ id: "open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [] }] };
    const testcase = { artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", testCaseId: "TC", revisionId: "REV", instanceId: "INSTANCE", title: "Save", steps: [{ id: "open", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ", role: "member", behavior: "save", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" } };
    const coverage = { artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0", obligationId: "COV", requirementAnalysisArtifactId: "replaced-atomically", requirementId: "REQ", role: "member", behavior: "save", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved", required: true };
    await Promise.all([
      writeFile(paths.environment, JSON.stringify(environment)),
      writeFile(paths.requirement, JSON.stringify(requirement)),
      writeFile(paths.plan, JSON.stringify(plan)),
      writeFile(paths.testcase, JSON.stringify(testcase)),
      writeFile(paths.coverage, JSON.stringify(coverage)),
    ]);

    const bootstrapped = await bootstrapPlanningBundle({
      root,
      environmentPath: paths.environment,
      requirementPath: paths.requirement,
      planPath: paths.plan,
      testCasePaths: [paths.testcase],
      coveragePaths: [paths.coverage],
    });
    expect(bootstrapped.bundle.artifacts).toHaveLength(4);
    const source = await RunWorkspace.open(root, bootstrapped.runId);
    const metadata = JSON.parse(await readFile(join(source.path, "run-metadata.json"), "utf8")) as { status: string };
    expect(metadata.status).toBe("COMPLETED");
    expect((await source.readRegisteredArtifacts()).map((artifact) => artifact.record.type).sort())
      .toEqual(["coverage-obligation", "environment-profile", "requirement-analysis", "test-case", "test-plan"]);
    await source.close();
  });

  it("fails fast naming the offending draft file and creates no run directory when a bootstrap draft is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-workflow-bootstrap-invalid-")); roots.push(root);
    const paths = {
      environment: join(root, "environment.json"),
      requirement: join(root, "requirement.json"),
      plan: join(root, "plan.json"),
      testcase: join(root, "testcase.json"),
      coverage: join(root, "coverage.json"),
    };
    const requirement = { artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA" };
    const plan = { artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN", approvalPolicy: { mode: "human-review" }, testCases: [{ testCaseId: "TC", title: "Save", expectedResults: [{ id: "ER", requirementId: "REQ", authority: "AUTHORITATIVE", text: "Saved" }], steps: [{ id: "open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [] }] };
    const testcase = { artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", testCaseId: "TC", revisionId: "REV", instanceId: "INSTANCE", title: "Save", steps: [{ id: "open", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ", role: "member", behavior: "save", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" } };
    const coverage = { artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0", obligationId: "COV", requirementAnalysisArtifactId: "replaced-atomically", requirementId: "REQ", role: "member", behavior: "save", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved", required: true };
    await Promise.all([
      writeFile(paths.environment, JSON.stringify(environment)),
      writeFile(paths.requirement, JSON.stringify(requirement)),
      writeFile(paths.plan, JSON.stringify(plan)),
      writeFile(paths.testcase, JSON.stringify(testcase)),
      writeFile(paths.coverage, JSON.stringify(coverage)),
    ]);

    const error: Error = await bootstrapPlanningBundle({
      root,
      environmentPath: paths.environment,
      requirementPath: paths.requirement,
      planPath: paths.plan,
      testCasePaths: [paths.testcase],
      coveragePaths: [paths.coverage],
    }).then(
      () => { throw new Error("expected bootstrapPlanningBundle to reject"); },
      (caught: unknown) => caught as Error,
    );

    expect(error.message).toContain(paths.requirement);
    expect(error.message).toContain("statements");
    await expect(readdir(join(root, "qa-results"))).rejects.toThrow(/ENOENT/);
  });

  it("creates parseable plan and source-bound inputs without scanning for a latest run", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-workflow-scaffold-")); roots.push(root);
    const envPath = join(root, "environment.json"); const planPath = join(root, "plan.json");
    await writeFile(envPath, JSON.stringify(environment));
    const plan = await scaffoldWorkflowInput({ root, mode: "plan", outputPath: planPath, environmentPath: envPath });
    expect(plan).toMatchObject({ root, mode: "plan", environmentProfile: environment });
    const workspace = await RunWorkspace.create({ root, mode: "plan", environmentProfile: environment });
    const requirement = await workspace.registerArtifactValue({ type: "requirement-analysis", relationships: [], value: { artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA", statements: [{ requirementId: "REQ", sourceProvenance: { kind: "user", reference: "fixture" }, normalizedText: "User must save", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] }] } });
    const planArtifact = await workspace.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: { artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN", approvalPolicy: { mode: "human-review" }, testCases: [{ testCaseId: "TC", title: "Save", expectedResults: [{ id: "ER", requirementId: "REQ", authority: "AUTHORITATIVE", text: "Saved" }], steps: [{ id: "open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [] }] } });
    await workspace.registerArtifactValue({ type: "test-case", relationships: [planArtifact.id], value: { artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", testCaseId: "TC", revisionId: "REV", instanceId: "INSTANCE", title: "Save", steps: [{ id: "open", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ", role: "member", behavior: "save", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" } } });
    await workspace.registerArtifactValue({ type: "coverage-obligation", relationships: [requirement.id], value: { artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0", obligationId: "COV", requirementAnalysisArtifactId: requirement.id, requirementId: "REQ", role: "member", behavior: "save", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved", required: true } });
    await workspace.finalize("plan"); await workspace.close();
    const sourcePath = join(root, "source.json");
    const source = await scaffoldWorkflowInput({ root, mode: "full", outputPath: sourcePath, sourceRoot: root, sourceRunId: workspace.runId });
    expect(source).toMatchObject({ mode: "full", bundle: { sourceRunId: workspace.runId }, environmentProfile: environment });
    expect(JSON.parse(await readFile(sourcePath, "utf8"))).toEqual(source);
    await scaffoldWorkflowInput({ root, mode: "plan", outputPath: join(root, "runnable-plan.json"), sourceRoot: root, sourceRunId: workspace.runId });
    await expect(runLocalWorkflow({ cwd: root, inputPath: join(root, "runnable-plan.json") })).resolves.toMatchObject({ mode: "plan", outcome: "COMPLETED" });
    const successViaCli = await runCli(["workflow", "run", "--input", join(root, "runnable-plan.json")], { cwd: root });
    expect(successViaCli.exitCode).toBe(ExitCode.SUCCESS);
    expect(JSON.parse(successViaCli.stdout)).toMatchObject({ mode: "plan", outcome: "COMPLETED" });
    const empty = await RunWorkspace.create({ root, mode: "plan", environmentProfile: environment }); await empty.finalize("plan"); await empty.close();
    await expect(scaffoldWorkflowInput({ root, mode: "plan", outputPath: join(root, "empty.json"), sourceRoot: root, sourceRunId: empty.runId })).rejects.toThrow(/required canonical planning/i);
    const manifestPath = join(root, "qa-results", workspace.runId, "artifact-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: unknown[] };
    await writeFile(manifestPath, JSON.stringify({ ...manifest, artifacts: [...manifest.artifacts, { id: "unexpected", type: "test-result", sha256: "a".repeat(64), relativePath: "artifacts/unexpected.json" }] }));
    await expect(scaffoldWorkflowInput({ root, mode: "plan", outputPath: join(root, "unsafe.json"), sourceRoot: root, sourceRunId: workspace.runId })).rejects.toThrow(/non-planning/i);
    const verified = await runCli(["runtime", "verify", "--range", ">=0.1.0 <1.0.0"], { cwd: root });
    expect(verified.exitCode).toBe(0); expect(JSON.parse(verified.stdout)).toMatchObject({ compatible: true });
  });
});

// Phase 8b MODE-1: the CLI wiring the three previously-unreachable modes (exploratory, retest,
// regression) need -- an unknown mode, a charter, a change scope, and a retest source bug, all
// refused or resolved at scaffold time rather than deep inside `workflow run`.
describe("workflow scaffold: modes, charter, change scope, and retest wiring", () => {
  let root: string;
  let envPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qa-workflow-modes-"));
    roots.push(root);
    envPath = join(root, "environment.json");
    await writeFile(envPath, JSON.stringify(environment));
  });

  it("refuses a mode that is not a public workflow mode", async () => {
    await expect(scaffoldWorkflowInput({ root, mode: "regresion", outputPath: join(root, "typo.json"), environmentPath: envPath }))
      .rejects.toThrow(/mode/i);
  });

  it("inlines a change scope so the run input stays one closed file", async () => {
    const scopePath = join(root, "scope.json");
    await writeFile(scopePath, JSON.stringify({ changes: [{ id: "CHG-1", requirementIds: ["REQ-1"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }], provenance: { kind: "declared-change", reference: "PR-482" } }));

    const input = await scaffoldWorkflowInput({ root, mode: "regression", outputPath: join(root, "regression.json"), environmentPath: envPath, changeScopePath: scopePath });

    expect(input.changeScope).toMatchObject({ provenance: { kind: "declared-change", reference: "PR-482" } });
    expect(input.runtime).toMatchObject({ changeScopeSourceId: "local-change-scope" });
  });

  it("refuses a change scope declaring no changes, at the edge", async () => {
    const scopePath = join(root, "empty-scope.json");
    await writeFile(scopePath, JSON.stringify({ changes: [], provenance: { kind: "declared-change", reference: "PR-0" } }));

    await expect(scaffoldWorkflowInput({ root, mode: "regression", outputPath: join(root, "empty.json"), environmentPath: envPath, changeScopePath: scopePath }))
      .rejects.toThrow(/change/i);
  });

  /**
   * `recovery.md` promises every scaffold option is validated AT SCAFFOLD TIME under a table headed "Every
   * refusal below is `INVALID_ARTIFACT`, exit `3`", but only `changes.length > 0` was checked. A change
   * missing any of the five mapping arrays reached `registerChangeScope`, whose sort spread threw a raw
   * `TypeError` -- `ABORTED_OR_INTERNAL`, exit 5, from inside `select-regression` rather than at the edge.
   * Each row below drops exactly one required part, so the guard cannot pass by checking only the first.
   */
  it.each([
    ["a change that is not an object", { changes: ["CHG-1"] }],
    ["a change with no id", { changes: [{ requirementIds: [], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }] }],
    ["a change whose id is not a string", { changes: [{ id: 7, requirementIds: [], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }] }],
    ["a change missing requirementIds", { changes: [{ id: "CHG-1", codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }] }],
    ["a change missing codeSurfaces", { changes: [{ id: "CHG-1", requirementIds: [], declaredDependencies: [], gitPaths: [], userScope: [] }] }],
    ["a change missing declaredDependencies", { changes: [{ id: "CHG-1", requirementIds: [], codeSurfaces: [], gitPaths: [], userScope: [] }] }],
    ["a change missing gitPaths", { changes: [{ id: "CHG-1", requirementIds: [], codeSurfaces: [], declaredDependencies: [], userScope: [] }] }],
    ["a change missing userScope", { changes: [{ id: "CHG-1", requirementIds: [], codeSurfaces: [], declaredDependencies: [], gitPaths: [] }] }],
    ["a mapping array holding something other than strings", { changes: [{ id: "CHG-1", requirementIds: [3], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }] }],
  ] as const)("refuses %s as INVALID_ARTIFACT at the edge, not a raw TypeError inside select-regression", async (label, scope) => {
    const scopePath = join(root, `malformed-${label.replace(/[^a-z]+/gi, "-")}.json`);
    await writeFile(scopePath, JSON.stringify({ ...scope, provenance: { kind: "declared-change", reference: "PR-482" } }));
    const outputPath = join(root, `malformed-${label.replace(/[^a-z]+/gi, "-")}-input.json`);

    const failure = await scaffoldWorkflowInput({ root, mode: "regression", outputPath, environmentPath: envPath, changeScopePath: scopePath })
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(QaSkillsError);
    expect((failure as QaSkillsError).code).toBe("INVALID_ARTIFACT");
    expect((failure as Error).message).toMatch(/change/i);
    // A refusal at the edge writes nothing, which is what "before anything is written" has to mean.
    await expect(readFile(outputPath, "utf8")).rejects.toThrow();
  });

  it("validates a charter at scaffold time rather than deep in the run", async () => {
    const charterPath = join(root, "charter.json");
    await writeFile(charterPath, JSON.stringify({ charterId: "CHARTER-1", mission: "explore checkout", scope: ["checkout"], roles: ["member"], heuristics: ["follow the money"], safetyRules: ["RULE-1"], actions: [{ actionId: "ACT-1", target: "/checkout", kind: "navigate", sideEffect: "none", safetyRuleId: "RULE-1" }], actionBudget: 5, timeBudgetMinutes: 10, stopConditions: ["budget spent"] }));

    const input = await scaffoldWorkflowInput({ root, mode: "exploratory", outputPath: join(root, "exploratory.json"), environmentPath: envPath, charterPath });

    expect(input.charter).toMatchObject({ charterId: "CHARTER-1" });
  });

  it("refuses a charter whose action list exceeds its budget", async () => {
    const charterPath = join(root, "over-budget.json");
    await writeFile(charterPath, JSON.stringify({
      charterId: "CHARTER-2", mission: "explore checkout", scope: ["checkout"], roles: ["member"],
      heuristics: ["follow the money"], safetyRules: ["RULE-1"],
      actions: [{ actionId: "ACT-1", target: "/checkout", kind: "navigate", sideEffect: "none", safetyRuleId: "RULE-1" }],
      actionBudget: 0, timeBudgetMinutes: 10, stopConditions: ["budget spent"],
    }));

    await expect(scaffoldWorkflowInput({ root, mode: "exploratory", outputPath: join(root, "over-budget-input.json"), environmentPath: envPath, charterPath }))
      .rejects.toThrow(/budget/i);
  });

  // A nonexistent run ID must refuse cleanly, not crash on a raw Node ENOENT: an unhandled ENOENT
  // propagates through program.ts's generic catch as ABORTED_OR_INTERNAL (exit 5) with a raw filesystem
  // path in the message, rather than the same clean INVALID_ARTIFACT (exit 3) every other scaffold-time
  // refusal in this file uses.

  it("refuses a --bug-run-id that does not exist, rather than crashing on a raw ENOENT", async () => {
    await expect(scaffoldWorkflowInput({ root, mode: "retest", outputPath: join(root, "no-such-bug-run.json"), environmentPath: envPath, bugRunId: "20260101T000000Z-abcdef" }))
      .rejects.toThrow(/bug run 20260101T000000Z-abcdef was not found/i);
  });

  it("refuses a --source-run-id that does not exist, rather than crashing on a raw ENOENT", async () => {
    await expect(scaffoldWorkflowInput({ root, mode: "plan", outputPath: join(root, "no-such-source-run.json"), sourceRoot: root, sourceRunId: "20260101T000000Z-abcdef" }))
      .rejects.toThrow(/source run 20260101T000000Z-abcdef was not found/i);
  });

  // The ENOENT translation above must not widen into swallowing every read failure: a run directory
  // that EXISTS but holds an unparseable manifest is a different, non-"missing" error (no `.code` at
  // all, since it never reaches the filesystem layer) and must still surface as the internal error it
  // is, not be folded into the "was not found" edge refusal.
  it("does not swallow a non-ENOENT error reading a bug run's manifest", async () => {
    const corruptRunId = "20260101T000000Z-fedcba";
    await mkdir(join(root, "qa-results", corruptRunId), { recursive: true });
    await writeFile(join(root, "qa-results", corruptRunId, "artifact-manifest.json"), "not valid json");
    const error: Error = await scaffoldWorkflowInput({ root, mode: "retest", outputPath: join(root, "corrupt-bug-run.json"), environmentPath: envPath, bugRunId: corruptRunId })
      .then(() => { throw new Error("expected scaffoldWorkflowInput to reject"); }, (caught: unknown) => caught as Error);
    expect(error.message).not.toMatch(/was not found/i);
    expect(error.message).toMatch(/json/i);
  });

  it("reads the retest source bug and its checksum from the named run's manifest", async () => {
    // TWO RUNS ARE REQUIRED HERE, and this is a consequence of the design rather than a fixture quirk:
    // scaffold's bundle path refuses a run holding non-planning artifacts (src/cli/workflow.ts), so
    // the executed run below cannot supply the bundle. `planRunId` is a separate planning-only terminal
    // run carrying the SAME identity triple, matched by `planningOnlyRun`/`executedRunWithBug` sharing
    // `bugIdentity`.
    const planRunId = await planningOnlyRun(root, envPath, bugIdentity);
    const executed = await executedRunWithBug(root);

    const input = await scaffoldWorkflowInput({ root, mode: "retest", outputPath: join(root, "retest.json"), sourceRoot: root, sourceRunId: planRunId, bugRunId: executed.runId });

    expect(input.linkedRunId).toBe(executed.runId);
    expect(input.retest).toMatchObject({ sourceBug: { artifactId: executed.bugArtifactId, sha256: executed.bugSha256 } });
  });

  it("refuses a bug run holding several bug reports unless one is named", async () => {
    const planRunId = await planningOnlyRun(root, envPath, bugIdentity);
    const executed = await executedRunWithBug(root, { bugs: 2 });
    await expect(scaffoldWorkflowInput({ root, mode: "retest", outputPath: join(root, "ambiguous.json"), sourceRoot: root, sourceRunId: planRunId, bugRunId: executed.runId }))
      .rejects.toThrow(/bug/i);
  });

  it("resolves the exact bug artifact named by --bug-artifact-id among several", async () => {
    const planRunId = await planningOnlyRun(root, envPath, bugIdentity);
    const executed = await executedRunWithBug(root, { bugs: 2 });
    const input = await scaffoldWorkflowInput({ root, mode: "retest", outputPath: join(root, "named.json"), sourceRoot: root, sourceRunId: planRunId, bugRunId: executed.runId, bugArtifactId: executed.bugArtifactId });
    expect(input.retest).toMatchObject({ sourceBug: { artifactId: executed.bugArtifactId, sha256: executed.bugSha256 } });
  });

  // Resolves the ambiguity the brief flagged under "Before You Begin": naming an artifact that exists
  // but is not a `bug-report` is refused exactly like naming an ID that does not exist at all --
  // `bugArtifactId` is looked up within the bug-report subset, never the unfiltered artifact list, so
  // it can never resolve to some other registered artifact type.
  it("refuses a --bug-artifact-id that does not name a registered bug report", async () => {
    const planRunId = await planningOnlyRun(root, envPath, bugIdentity);
    const executed = await executedRunWithBug(root);
    const manifest = JSON.parse(await readFile(join(root, "qa-results", executed.runId, "artifact-manifest.json"), "utf8")) as { artifacts: readonly { id: string; type: string }[] };
    const nonBugArtifact = manifest.artifacts.find((artifact) => artifact.type !== "bug-report");
    if (!nonBugArtifact) throw new Error("expected the executed run to hold a non-bug-report artifact");
    await expect(scaffoldWorkflowInput({ root, mode: "retest", outputPath: join(root, "wrong-artifact.json"), sourceRoot: root, sourceRunId: planRunId, bugRunId: executed.runId, bugArtifactId: nonBugArtifact.id }))
      .rejects.toThrow(/bug/i);
  });

  // The brief's mutation table names two rows that would otherwise only redden a Task 5 test that does
  // not exist yet in this codebase: dropping `changeScopeSources` from `runLocalWorkflow`, and dropping
  // the production `linkedRunId` pre-check. Both are covered here, minimally and directly, rather than
  // deferred -- neither needs the full six-mode CLI reachability harness Task 5 owns.

  it("refuses a retest with no linked run before any workspace is created (production adapter)", async () => {
    // Exercises `createQaTester` directly -- the production seam `runLocalWorkflow` calls into -- with an
    // EMPTY runtime registry and no bundle. The pre-check under test (run-workflow.ts, beside the former
    // `ensureCanonicalBundle`/`runQaTesterWithAdapters` boundary) fires before `RunWorkspace.create`, so
    // reaching it needs nothing else configured; if the mutation table's "drop the linkedRunId pre-check"
    // row were applied, this would instead run to `RunWorkspace.create` and fail later for a missing
    // runtime, never mentioning the missing link.
    const { createQaTester } = await import("../../src/orchestration/qa-tester.js");
    await expect(createQaTester({})({ root, mode: "retest", environmentProfile: environment, retest: { sourceBug: { artifactId: "BUG-1", sha256: "a".repeat(64) } } }))
      .rejects.toThrow(/linked immutable run/i);
    // No run directory was created: the guard fires before any workspace exists, so an invalid
    // scaffolded retest leaves no orphaned qa-results/<runId> behind for a caller to clean up.
    await expect(readdir(join(root, "qa-results"))).rejects.toThrow(/ENOENT/);
  });

  it("wires a scaffolded change scope into runLocalWorkflow's change-scope source registry", async () => {
    const scopePath = join(root, "cli-scope.json");
    await writeFile(scopePath, JSON.stringify({ changes: [{ id: "CHG-1", requirementIds: ["REQ-1"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }], provenance: { kind: "declared-change", reference: "PR-482" } }));
    const inputPath = join(root, "retest-input.json");
    await scaffoldWorkflowInput({ root, mode: "retest", outputPath: inputPath, environmentPath: envPath, changeScopePath: scopePath });
    // Hand-add a linkedRunId (validly shaped but pointing at no real run) and a placeholder source bug
    // so only the change-scope wiring is under test here -- neither is ever dereferenced, because the
    // run fails at the bundle check below, before `reproduce-bug` would open the linked run or read the
    // bug reference.
    const raw = JSON.parse(await readFile(inputPath, "utf8")) as Record<string, unknown>;
    await writeFile(inputPath, JSON.stringify({ ...raw, linkedRunId: "20260101T000000Z-abcdef", retest: { sourceBug: { artifactId: "BUG-1", sha256: "a".repeat(64) } } }));

    // Without `changeScopeSources` wired, `runLocalWorkflow` fails at run-workflow.ts's retest gate with
    // "change-scope source is not configured" BEFORE the bundle is even checked (run-workflow.ts, the
    // `if (input.mode === "retest")` block). With it wired, that gate passes and the run instead fails
    // downstream for lacking a canonical plan bundle -- proof, by way of the DIFFERENT failure reached,
    // that the registry `runLocalWorkflow` populates from `input.changeScope` was actually consulted. If
    // the mutation table's "drop changeScopeSources from runLocalWorkflow" row were applied, this
    // assertion would see the earlier "not configured" message instead and fail.
    await expect(runLocalWorkflow({ cwd: root, inputPath })).rejects.toThrow(/canonical plan bundle/i);
  });
});

// Phase 8b Task 5b: the two flags the two-lane flow needs between pause and resume --
// `--observed-execution` and `--resume-run-id` -- so an operator scaffolds the resume input instead of
// hand-editing the JSON `tests/cli/workflow-modes.test.ts`'s two-lane test currently produces by hand.
describe("workflow scaffold: observed execution and resume run wiring", () => {
  let root: string;
  let envPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qa-workflow-resume-"));
    roots.push(root);
    envPath = join(root, "environment.json");
    await writeFile(envPath, JSON.stringify(environment));
  });

  it("emits observedExecution: { expected: true } and changes nothing else", async () => {
    const withoutFlag = await scaffoldWorkflowInput({ root, mode: "regression", outputPath: join(root, "without.json"), environmentPath: envPath });
    const withFlag = await scaffoldWorkflowInput({ root, mode: "regression", outputPath: join(root, "with.json"), environmentPath: envPath, observedExecution: true });
    expect(withFlag).toEqual({ ...withoutFlag, observedExecution: { expected: true } });
  });

  it("emits resumeRunId", async () => {
    const openRun = await RunWorkspace.create({ root, mode: "regression", environmentProfile: environment });
    await openRun.close();
    const withoutFlag = await scaffoldWorkflowInput({ root, mode: "regression", outputPath: join(root, "without.json"), environmentPath: envPath });
    const withFlag = await scaffoldWorkflowInput({ root, mode: "regression", outputPath: join(root, "with.json"), environmentPath: envPath, resumeRunId: openRun.runId });
    expect(withFlag).toEqual({ ...withoutFlag, resumeRunId: openRun.runId });
  });

  // Both flags together must produce EXACTLY the shape `tests/cli/workflow-modes.test.ts`'s two-lane test
  // hand-edits today (`{ ...pausedInput, resumeRunId: pausedResult.runId }`, where `pausedInput` is the
  // scaffolded input plus `observedExecution: { expected: true }`) -- that test already proves the real
  // runner accepts exactly that shape as a resume, end to end with a real browser and a real Playwright
  // runner. Reproducing the identical shape here, cheaply and without either, is the proof this task owns;
  // the full end-to-end re-proof through the flags themselves is Task 6's.
  it("both flags together produce exactly the shape the two-lane flow's hand-edited resume input has", async () => {
    const openRun = await RunWorkspace.create({ root, mode: "regression", environmentProfile: environment });
    await openRun.close();
    const baseInput = await scaffoldWorkflowInput({ root, mode: "regression", outputPath: join(root, "base.json"), environmentPath: envPath });
    const resumeInput = await scaffoldWorkflowInput({ root, mode: "regression", outputPath: join(root, "resume.json"), environmentPath: envPath, observedExecution: true, resumeRunId: openRun.runId });
    expect(resumeInput).toEqual({ ...baseInput, observedExecution: { expected: true }, resumeRunId: openRun.runId });
  });

  // The regression guard for every existing caller: a scaffold with NEITHER flag must carry neither KEY,
  // not merely an undefined value for each -- `JSON.stringify` drops undefined-valued keys either way, so
  // only checking the key's presence (rather than its value) would leave a hand-rolled `"key" in object`
  // spread bug undetected.
  it("emits neither observedExecution nor resumeRunId when neither flag is given", async () => {
    const input = await scaffoldWorkflowInput({ root, mode: "regression", outputPath: join(root, "neither.json"), environmentPath: envPath });
    expect("observedExecution" in input).toBe(false);
    expect("resumeRunId" in input).toBe(false);
  });

  // Refusal decision 1 (task-5b-brief.md): a --resume-run-id naming a run that does not exist under
  // --root must refuse cleanly, naming the run, rather than crashing on the raw ENOENT measured from
  // `RunWorkspace.open` itself.
  it("refuses a --resume-run-id that does not exist, rather than crashing on a raw ENOENT", async () => {
    const outputPath = join(root, "no-such-resume-run.json");
    await expect(scaffoldWorkflowInput({ root, mode: "regression", outputPath, environmentPath: envPath, resumeRunId: "20260101T000000Z-abcdef" }))
      .rejects.toThrow(/resume run 20260101T000000Z-abcdef was not found/i);
    await expect(readFile(outputPath, "utf8")).rejects.toThrow(/ENOENT/);
  });

  // Refusal decision 2 (task-5b-brief.md): a --resume-run-id naming a TERMINAL run must refuse cleanly
  // and by name -- measured (not guessed from the other paths' shape, which all require terminal) that
  // `RunWorkspace.open` itself does not refuse a terminal run, so without this check the deep failure
  // would instead be `QaSkillsError("Terminal workspace is immutable", "TERMINAL_WORKSPACE")`, several
  // operations later inside `workflow run`, naming neither the run nor "resume".
  it("refuses a --resume-run-id naming a terminal run, rather than the runner's own deep TERMINAL_WORKSPACE failure", async () => {
    const terminal = await RunWorkspace.create({ root, mode: "plan", environmentProfile: environment });
    await terminal.finalize("plan");
    const terminalRunId = terminal.runId;
    await terminal.close();
    const outputPath = join(root, "terminal-resume-run.json");
    await expect(scaffoldWorkflowInput({ root, mode: "regression", outputPath, environmentPath: envPath, resumeRunId: terminalRunId }))
      .rejects.toThrow(new RegExp(`resume run ${terminalRunId} is terminal`, "i"));
    await expect(readFile(outputPath, "utf8")).rejects.toThrow(/ENOENT/);
  });

  // Fix round 1: the terminal check (decision 2) must fail CLOSED on malformed metadata, matching its two
  // siblings (the source-run and bug-run terminal checks above, both of which refuse when the metadata is
  // not a record at all, not only when it fails their positive condition). A `run-metadata.json` that
  // parses to something other than a record is exactly the kind of "let the runner discover it three
  // layers down" gap decisions 1 and 2 exist to close, so it must be refused here too, and the message
  // must say what is actually wrong rather than guess "terminal" for something that was never inspected.
  it("refuses a --resume-run-id whose metadata does not parse as a run, rather than silently accepting it", async () => {
    const malformedRunId = "20260101T000000Z-fedcba";
    await mkdir(join(root, "qa-results", malformedRunId), { recursive: true });
    await writeFile(join(root, "qa-results", malformedRunId, "artifact-manifest.json"), JSON.stringify({ artifacts: [] }));
    await writeFile(join(root, "qa-results", malformedRunId, "run-metadata.json"), JSON.stringify(["not", "a", "record"]));
    const outputPath = join(root, "malformed-resume-run.json");
    await expect(scaffoldWorkflowInput({ root, mode: "regression", outputPath, environmentPath: envPath, resumeRunId: malformedRunId }))
      .rejects.toThrow(new RegExp(`resume run ${malformedRunId} metadata could not be read as a run`, "i"));
    await expect(readFile(outputPath, "utf8")).rejects.toThrow(/ENOENT/);
  });

  // Refusal decision 3 (task-5b-brief.md): `--observed-execution` with a mode that never runs
  // `execute-browser-test` (`plan`, `exploratory`) would otherwise be a silent no-op the operator reads
  // as armed -- refused at the edge instead, for honesty rather than safety.
  it("refuses --observed-execution with plan or exploratory mode, which never run execute-browser-test", async () => {
    const planOutput = join(root, "plan-observed.json");
    await expect(scaffoldWorkflowInput({ root, mode: "plan", outputPath: planOutput, environmentPath: envPath, observedExecution: true }))
      .rejects.toThrow(/observed-execution.*plan mode/i);
    await expect(readFile(planOutput, "utf8")).rejects.toThrow(/ENOENT/);

    const exploratoryOutput = join(root, "exploratory-observed.json");
    await expect(scaffoldWorkflowInput({ root, mode: "exploratory", outputPath: exploratoryOutput, environmentPath: envPath, observedExecution: true }))
      .rejects.toThrow(/observed-execution.*exploratory mode/i);
    await expect(readFile(exploratoryOutput, "utf8")).rejects.toThrow(/ENOENT/);
  });

  /**
   * `retest` was accepted, and it is the WORST mode to accept, because the flag's cost there is not a
   * no-op — it is a run that can never finish. `retest` runs `execute-browser-test`, so the pause really
   * arms and really fires; but a `retest-result` binds a reproduction to `sourceAttemptArtifactId` and
   * `attemptId`, which a batch entry cannot carry, so `retest` is lane-1 by construction (human ruling 2)
   * and drives its selection whatever a batch observed. Meanwhile `observedExecution` sits inside
   * `workflowInputChecksum`, so it cannot be dropped on resume, and on a project with no bound tagged spec
   * `execute playwright` refuses with `OBSERVED_RUN_NO_ENTRIES`. There is no abort command. The flag's own
   * justification comment applies more strongly here than to the two modes it already refused.
   */
  it("refuses --observed-execution with retest mode, which is lane-1 by construction", async () => {
    const retestOutput = join(root, "retest-observed.json");
    await expect(scaffoldWorkflowInput({ root, mode: "retest", outputPath: retestOutput, environmentPath: envPath, observedExecution: true }))
      .rejects.toThrow(/observed-execution.*retest/i);
    await expect(readFile(retestOutput, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("still accepts --observed-execution for the two modes whose residual it actually feeds", async () => {
    // The refusal must be a three-mode list, not "every mode but regression": `execute` and `full` accept a
    // batch as an execution record and can legitimately arm the pause, they simply subtract nothing.
    for (const mode of ["execute", "full", "regression"] as const) {
      const input = await scaffoldWorkflowInput({ root, mode, outputPath: join(root, `${mode}-observed.json`), environmentPath: envPath, observedExecution: true });
      expect(input.observedExecution).toEqual({ expected: true });
    }
  });
});
