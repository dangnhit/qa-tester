import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";
import { bootstrapPlanningBundle, runLocalWorkflow, scaffoldWorkflowInput } from "../../src/cli/workflow.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const environment = { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "env", name: "Fixture", classification: "test", baseUrl: "https://fixture.test", productionReadOnly: false } as const;

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
    const testcase = { artifactType: "test-case", schemaVersion: "1.0.0", producerVersion: "1.0.0", testCaseId: "TC", revisionId: "REV", instanceId: "INSTANCE", title: "Save", steps: [{ id: "open", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ", role: "member", behavior: "save", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" } };
    const coverage = { artifactType: "coverage-obligation", schemaVersion: "2.0.0", producerVersion: "1.0.0", obligationId: "COV", requirementAnalysisArtifactId: "replaced-atomically", requirementId: "REQ", role: "member", behavior: "save", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved", required: true };
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
    const testcase = { artifactType: "test-case", schemaVersion: "1.0.0", producerVersion: "1.0.0", testCaseId: "TC", revisionId: "REV", instanceId: "INSTANCE", title: "Save", steps: [{ id: "open", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ", role: "member", behavior: "save", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" } };
    const coverage = { artifactType: "coverage-obligation", schemaVersion: "2.0.0", producerVersion: "1.0.0", obligationId: "COV", requirementAnalysisArtifactId: "replaced-atomically", requirementId: "REQ", role: "member", behavior: "save", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved", required: true };
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
    await workspace.registerArtifactValue({ type: "test-case", relationships: [planArtifact.id], value: { artifactType: "test-case", schemaVersion: "1.0.0", producerVersion: "1.0.0", testCaseId: "TC", revisionId: "REV", instanceId: "INSTANCE", title: "Save", steps: [{ id: "open", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ", role: "member", behavior: "save", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" } } });
    await workspace.registerArtifactValue({ type: "coverage-obligation", relationships: [requirement.id], value: { artifactType: "coverage-obligation", schemaVersion: "2.0.0", producerVersion: "1.0.0", obligationId: "COV", requirementAnalysisArtifactId: requirement.id, requirementId: "REQ", role: "member", behavior: "save", executionSurface: "browser", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved", required: true } });
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
