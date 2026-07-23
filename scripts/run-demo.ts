import { chromium } from "@playwright/test";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

import { serveDemoFixture } from "../fixtures/demo/server.js";
import { RunWorkspace, type ArtifactRecord } from "../src/core/run-workspace.js";
import { createQaTester, type CanonicalPlanBundleRef } from "../src/operations/run-workflow.js";
import { sha256Fingerprint } from "../src/planning/testcase-revision.js";
import { TestDataHookRegistry } from "../src/test-data/hooks.js";

type DemoInstance = Readonly<{ instanceId: string; viewport: Readonly<{ width: number; height: number }> }>;
type DemoTestcase = Readonly<{
  schemaVersion: string;
  requirement: Readonly<{ id: string; text: string }>;
  testCase: Readonly<{ id: string; revisionId: string; title: string; expectedText: string }>;
  matrix: readonly DemoInstance[];
}>;
type DemoConfig = Readonly<{
  schemaVersion: string;
  host: string;
  port: number;
  browser: string;
  headless: boolean;
  externalNetwork: boolean;
  evidence: Readonly<{ screenshot: string; console: string; network: string; logs: string; trace: string; annotateFailures: boolean }>;
}>;

export type DemoResult = Readonly<{
  root: string;
  run: Readonly<{ id: string; status: string }>;
  attempts: readonly Readonly<{ id: string; instanceId: string; status: string; classification: string }>[];
  files: readonly string[];
  report: Readonly<{ releaseRecommendation: string }>;
  validation: Readonly<{ valid: boolean; diagnostics: readonly unknown[] }>;
  telemetry: Readonly<{ consoleErrors: readonly string[]; failedRequests: readonly string[] }>;
}>;

const fixtureDirectory = fileURLToPath(new URL("../fixtures/demo/", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadYaml<T>(name: string): Promise<T> {
  return YAML.parse(await readFile(join(fixtureDirectory, name), "utf8")) as T;
}

function assertFixture(testcase: DemoTestcase, config: DemoConfig): void {
  if (testcase.schemaVersion !== "1.0.0" || testcase.matrix.length !== 2) throw new Error("Demo testcase matrix is invalid");
  if (config.schemaVersion !== "1.0.0" || config.host !== "127.0.0.1" || config.port !== 0 || config.browser !== "chromium" || config.externalNetwork !== false) throw new Error("Demo configuration must remain localhost-only");
  if (config.evidence.screenshot !== "required" || config.evidence.console !== "required" || config.evidence.network !== "required" || config.evidence.logs !== "required" || config.evidence.trace !== "required" || !config.evidence.annotateFailures) throw new Error("Demo evidence configuration is incomplete");
  const ids = testcase.matrix.map((item) => item.instanceId);
  if (!ids.includes("INSTANCE-DEMO-DESKTOP") || !ids.includes("INSTANCE-DEMO-MOBILE")) throw new Error("Demo must declare desktop and mobile instances");
}

function browserDsl(baseUrl: string) {
  return {
    steps: [
      { id: "open", action: { kind: "open" as const, url: baseUrl }, sideEffect: "none" as const },
      { id: "save", action: { kind: "click" as const, locator: { role: "button", name: "Save profile" } }, sideEffect: "none" as const },
      {
        id: "verify-authoritative-message",
        action: { kind: "wait" as const, milliseconds: 150 },
        assertions: [{ kind: "count" as const, locator: { testId: "validation-message" }, count: 1 }],
        sideEffect: "none" as const,
      },
    ],
  };
}

async function createSourceBundle(root: string, baseUrl: string, testcase: DemoTestcase): Promise<CanonicalPlanBundleRef> {
  const environment = { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "ENV-DEMO-LOCAL", name: "Local intentional-failure fixture", classification: "test", baseUrl, productionReadOnly: false };
  const workspace = await RunWorkspace.create({ root, mode: "plan", environmentProfile: environment });
  try {
    const requirement = await workspace.registerArtifactValue({
      type: "requirement-analysis",
      relationships: [],
      value: {
        artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "0.1.0", requirementAnalysisId: "RA-DEMO",
        statements: [{ requirementId: testcase.requirement.id, sourceProvenance: { kind: "user", reference: "fixtures/demo/demo-testcase.yaml" }, normalizedText: testcase.requirement.text, authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] }],
      },
    });
    const dsl = browserDsl(baseUrl);
    const plan = await workspace.registerArtifactValue({
      type: "test-plan",
      relationships: [requirement.id],
      value: {
        artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "0.1.0", testPlanId: "PLAN-DEMO", approvalPolicy: { mode: "auto-approve-safe" },
        testCases: testcase.matrix.map((instance) => ({
          testCaseId: testcase.testCase.id,
          title: testcase.testCase.title,
          expectedResults: [{ id: `ER-${instance.instanceId}`, requirementId: testcase.requirement.id, authority: "AUTHORITATIVE", text: testcase.testCase.expectedText }],
          steps: [{ id: `plan-${instance.instanceId}`, action: { kind: "navigate", url: "/" }, sideEffect: "none" }],
          openQuestions: [],
          browserExecution: { revisionId: testcase.testCase.revisionId, instanceId: instance.instanceId, browserDsl: dsl, browserDslFingerprint: sha256Fingerprint(dsl) },
        })),
      },
    });
    const registered: ArtifactRecord[] = [requirement, plan];
    for (const instance of testcase.matrix) {
      const canonicalCase = await workspace.registerArtifactValue({
        type: "test-case",
        relationships: [plan.id],
        value: {
          artifactType: "test-case", schemaVersion: "1.0.0", producerVersion: "0.1.0",
          testCaseId: testcase.testCase.id, revisionId: testcase.testCase.revisionId, instanceId: instance.instanceId, title: testcase.testCase.title,
          steps: [{ id: `plan-${instance.instanceId}`, action: "navigate", sideEffect: "none" }],
          coverage: { requirementId: testcase.requirement.id, role: "member", behavior: "save profile", browser: "chromium", viewport: instance.viewport, accessibilityMethod: null, risk: "high", outcome: testcase.testCase.expectedText },
        },
      });
      registered.push(canonicalCase);
    }
    const coverage = await workspace.registerArtifactValue({
      type: "coverage-obligation",
      relationships: [requirement.id],
      value: {
        artifactType: "coverage-obligation", schemaVersion: "1.0.0", producerVersion: "0.1.0", obligationId: "COV-DEMO-SAVE", requirementAnalysisArtifactId: requirement.id,
        requirementId: testcase.requirement.id, role: "member", behavior: "save profile", browser: "chromium", viewport: testcase.matrix[0]!.viewport, accessibilityMethod: null, risk: "high", outcome: testcase.testCase.expectedText, required: true,
      },
    });
    registered.push(coverage);
    await workspace.finalize("plan");
    const artifacts = await Promise.all(registered.map((artifact) => workspace.readArtifactRecord(artifact.id)));
    return { sourceRunId: workspace.runId, artifacts: artifacts.map((artifact) => ({ artifactId: artifact.id, sha256: artifact.sha256 })) };
  } finally {
    await workspace.close();
  }
}

async function projectEvidence(root: string, runId: string, workspace: RunWorkspace, records: readonly ArtifactRecord[]): Promise<string[]> {
  const projectionRoot = join(root, "demo-artifacts", runId);
  const projected: string[] = [];
  for (const record of records) {
    let destination: string | undefined;
    if (record.mediaType === "image/png" && record.relativePath.includes("sanitized-raw")) destination = join("screenshots", "raw", basename(record.relativePath));
    if (record.mediaType === "image/png" && record.relativePath.includes("annotated")) destination = join("screenshots", "annotated", basename(record.relativePath));
    if (record.captureType === "trace" && record.mediaType === "application/zip") destination = join("traces", basename(record.relativePath));
    if (destination === undefined) continue;
    const absoluteDestination = join(projectionRoot, destination);
    await mkdir(dirname(absoluteDestination), { recursive: true });
    await copyFile(await workspace.resolve(record.relativePath), absoluteDestination);
    projected.push(destination.replaceAll("\\", "/"));
  }
  return projected.sort();
}

async function telemetryFrom(workspace: RunWorkspace, records: readonly ArtifactRecord[]): Promise<{ consoleErrors: string[]; failedRequests: string[] }> {
  const consoleErrors = new Set<string>();
  const failedRequests = new Set<string>();
  for (const record of records) {
    if (record.mediaType !== "application/json" || (record.captureType !== "console" && record.captureType !== "network" && record.captureType !== "log")) continue;
    const payload: unknown = JSON.parse(await readFile(await workspace.resolve(record.relativePath), "utf8"));
    if (!isRecord(payload) || !Array.isArray(payload.findings)) continue;
    for (const finding of payload.findings) {
      if (!isRecord(finding)) continue;
      if (finding.kind === "console" && finding.level === "error" && typeof finding.message === "string") consoleErrors.add(finding.message);
      if (finding.kind === "network" && typeof finding.url === "string") failedRequests.add(new URL(finding.url).pathname);
    }
  }
  return { consoleErrors: [...consoleErrors].sort(), failedRequests: [...failedRequests].sort() };
}

export async function runDemo(options: Readonly<{ root?: string }> = {}): Promise<DemoResult> {
  const root = resolve(options.root ?? process.cwd());
  const [testcase, config] = await Promise.all([loadYaml<DemoTestcase>("demo-testcase.yaml"), loadYaml<DemoConfig>("demo-config.yaml")]);
  assertFixture(testcase, config);
  const server = await serveDemoFixture();
  const browser = await chromium.launch({ headless: config.headless });
  try {
    const bundle = await createSourceBundle(root, server.baseUrl, testcase);
    const environment = { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "ENV-DEMO-LOCAL", name: "Local intentional-failure fixture", classification: "test", baseUrl: server.baseUrl, productionReadOnly: false };
    const workflow = await createQaTester({
      browserManagers: { demo: { browser, captureTrace: true, annotateFailures: true } },
      testDataRegistries: { demo: new TestDataHookRegistry([], {}) },
      evidencePolicies: { demo: { safety: { screenshot: "required", console: "required", network: "required", logs: "required" } } },
    })({ root, mode: "full", environmentProfile: environment, bundle, runtime: { browserManagerId: "demo", testDataRegistryId: "demo", evidencePolicyId: "demo" } });
    const workspace = await RunWorkspace.open(root, workflow.runId);
    try {
      const artifacts = await workspace.readRegisteredArtifacts();
      const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as { artifacts: ArtifactRecord[] };
      const records = manifest.artifacts;
      const metadata = JSON.parse(await readFile(join(workspace.path, "run-metadata.json"), "utf8")) as { status: string };
      const attempts = artifacts.filter((artifact) => artifact.record.type === "test-result").map((artifact) => ({ id: String(artifact.value.attemptId), instanceId: String(artifact.value.testCaseInstanceId), status: String(artifact.value.status), classification: String(artifact.value.failureClassification) }));
      const report = artifacts.find((artifact) => artifact.record.type === "qa-execution-report")?.value;
      if (!report || typeof report.releaseRecommendation !== "string") throw new Error("Demo QA report is missing");
      const files = await projectEvidence(root, workflow.runId, workspace, records);
      const telemetry = await telemetryFrom(workspace, records);
      const result: DemoResult = { root, run: { id: workflow.runId, status: metadata.status }, attempts, files, report: { releaseRecommendation: report.releaseRecommendation }, validation: workflow.validation, telemetry };
      const valid = result.run.status === "COMPLETED_WITH_FAILURES"
        && result.attempts.length === testcase.matrix.length
        && result.attempts.every((attempt) => attempt.status === "FAILED" && attempt.classification === "PRODUCT_DEFECT")
        && result.files.some((file) => file.startsWith("screenshots/raw/"))
        && result.files.some((file) => file.startsWith("screenshots/annotated/"))
        && result.files.some((file) => file.startsWith("traces/"))
        && result.report.releaseRecommendation === "NOT_READY"
        && result.validation.valid
        && result.telemetry.consoleErrors.includes("QA_DEMO_CONSOLE_ERROR")
        && result.telemetry.failedRequests.includes("/api/demo-failure");
      if (!valid) throw new Error(`Intentional defect was not completely detected: ${JSON.stringify(result)}`);
      return result;
    } finally {
      await workspace.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runDemo().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`QA Skills demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
