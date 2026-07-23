import { chromium } from "@playwright/test";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

import { serveDemoFixture } from "../fixtures/demo/server.js";
import { RunWorkspace, type ArtifactRecord, type RegisteredWorkspaceArtifact } from "../src/core/run-workspace.js";
import { executeCleanupRun } from "../src/operations/cleanup-run.js";
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
type DemoEvidenceSummary = Readonly<{
  instanceId: string;
  rawScreenshots: number;
  annotatedScreenshots: number;
  traces: number;
  console: number;
  network: number;
  annotation: Readonly<{ testCaseRevisionId: string; testCaseInstanceId: string; locator: string; label: string; testResultRelated: boolean }>;
}>;

export type DemoResult = Readonly<{
  root: string;
  run: Readonly<{ id: string; status: string }>;
  attempts: readonly Readonly<{ id: string; instanceId: string; status: string; classification: string }>[];
  files: readonly string[];
  report: Readonly<{ releaseRecommendation: string }>;
  validation: Readonly<{ valid: boolean; diagnostics: readonly unknown[] }>;
  telemetry: Readonly<{ consoleErrors: readonly string[]; failedRequests: readonly string[] }>;
  evidenceByInstance: readonly DemoEvidenceSummary[];
  screenshotEvidenceGaps: readonly Readonly<{ attemptId: string; reason: string }>[];
  traceEvidenceGaps: readonly Readonly<{ attemptId: string; reason: string }>[];
  cleanup: Readonly<{ status: string; resources: readonly string[] }>;
}>;

const fixtureDirectory = fileURLToPath(new URL("../fixtures/demo/", import.meta.url));
const authoritativeExpectedResultId = "ER-DEMO-SAVE";

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

function browserDsl(baseUrl: string, expectedText: string, resolveDemoSecret: boolean) {
  return {
    steps: [
      { id: "open", action: { kind: "open" as const, url: baseUrl }, sideEffect: "none" as const },
      ...(resolveDemoSecret ? [{ id: "fill-secret", action: { kind: "fill" as const, locator: { label: "Email" }, value: { secretRef: "demo-email" } }, sideEffect: "none" as const }] : []),
      { id: "save", action: { kind: "click" as const, locator: { role: "button", name: "Save profile" } }, sideEffect: "none" as const },
      {
        id: "verify-authoritative-message",
        action: { kind: "wait" as const, milliseconds: 150 },
        assertions: [{ kind: "text" as const, locator: { testId: "validation-message" }, text: expectedText, expectedResultId: authoritativeExpectedResultId }],
        sideEffect: "none" as const,
      },
    ],
  };
}

async function createSourceBundle(root: string, baseUrl: string, testcase: DemoTestcase, resolveDemoSecret: boolean): Promise<CanonicalPlanBundleRef> {
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
    const dsl = browserDsl(baseUrl, testcase.testCase.expectedText, resolveDemoSecret);
    const plan = await workspace.registerArtifactValue({
      type: "test-plan",
      relationships: [requirement.id],
      value: {
        artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "0.1.0", testPlanId: "PLAN-DEMO", approvalPolicy: { mode: "auto-approve-safe" },
        testCases: testcase.matrix.map((instance) => ({
          testCaseId: testcase.testCase.id,
          title: testcase.testCase.title,
          expectedResults: [{ id: authoritativeExpectedResultId, requirementId: testcase.requirement.id, authority: "AUTHORITATIVE", text: testcase.testCase.expectedText }],
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

function evidenceSummaries(artifacts: readonly RegisteredWorkspaceArtifact[], attempts: DemoResult["attempts"]): DemoEvidenceSummary[] {
  return attempts.map((attempt) => {
    const attemptArtifacts = artifacts.filter((artifact) => artifact.record.type === "evidence" && artifact.value.attemptId === attempt.id);
    const annotated = attemptArtifacts.find((artifact) => artifact.value.kind === "screenshot" && typeof artifact.value.relativePath === "string" && artifact.value.relativePath.includes("annotated"));
    const testResult = artifacts.find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === attempt.id);
    const provenance = isRecord(annotated?.value.provenance) ? annotated.value.provenance : {};
    const labels = Array.isArray(provenance.annotationLabels) ? provenance.annotationLabels.filter((label): label is string => typeof label === "string") : [];
    return {
      instanceId: attempt.instanceId,
      rawScreenshots: attemptArtifacts.filter((artifact) => artifact.value.kind === "screenshot" && typeof artifact.value.relativePath === "string" && artifact.value.relativePath.includes("sanitized-raw")).length,
      annotatedScreenshots: annotated === undefined ? 0 : 1,
      traces: attemptArtifacts.filter((artifact) => artifact.value.kind === "trace").length,
      console: attemptArtifacts.filter((artifact) => artifact.value.kind === "console").length,
      network: attemptArtifacts.filter((artifact) => artifact.value.kind === "network").length,
      annotation: {
        testCaseRevisionId: typeof annotated?.value.testCaseRevisionId === "string" ? annotated.value.testCaseRevisionId : "",
        testCaseInstanceId: typeof annotated?.value.testCaseInstanceId === "string" ? annotated.value.testCaseInstanceId : "",
        locator: typeof provenance.locator === "string" ? provenance.locator : "",
        label: labels[0] ?? "",
        testResultRelated: testResult !== undefined && annotated?.record.relationships.includes(testResult.record.id) === true,
      },
    };
  });
}

export async function withDemoResources<BrowserType extends Readonly<{ close: () => Promise<void> }>, Result>(
  dependencies: Readonly<{ serve: () => Promise<Readonly<{ baseUrl: string; close: () => Promise<void> }>>; launch: () => Promise<BrowserType> }>,
  operation: (resources: Readonly<{ server: Readonly<{ baseUrl: string; close: () => Promise<void> }>; browser: BrowserType }>) => Promise<Result>,
): Promise<Result> {
  const server = await dependencies.serve();
  try {
    const browser = await dependencies.launch();
    try {
      return await operation({ server, browser });
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

export async function runDemo(options: Readonly<{ root?: string; protectedEnvironment?: boolean; resolvedSecret?: string }> = {}): Promise<DemoResult> {
  const root = resolve(options.root ?? process.cwd());
  const [testcase, config] = await Promise.all([loadYaml<DemoTestcase>("demo-testcase.yaml"), loadYaml<DemoConfig>("demo-config.yaml")]);
  assertFixture(testcase, config);
  return withDemoResources({ serve: serveDemoFixture, launch: () => chromium.launch({ headless: config.headless }) }, async ({ server, browser }) => {
    const protectedEnvironment = options.protectedEnvironment === true;
    const resolveDemoSecret = options.resolvedSecret !== undefined || protectedEnvironment;
    const markerPath = join(root, ".qa-demo-owned-resource");
    const cleanupStatuses: string[] = [];
    try {
      const bundle = await createSourceBundle(root, server.baseUrl, testcase, resolveDemoSecret);
      const environment = { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "ENV-DEMO-LOCAL", name: "Local intentional-failure fixture", classification: "test", baseUrl: server.baseUrl, productionReadOnly: false };
      const testDataRegistry = new TestDataHookRegistry([{ id: "demo-owned-resource", kind: "api", fixture: "local-marker" }], {
        api: async () => {
          await writeFile(markerPath, "owned demo resource", { flag: "wx" });
          return [{ id: "RESOURCE-DEMO-OWNED", cleanupAction: markerPath }];
        },
      });
      const secret = options.resolvedSecret ?? "qa-protected@example.test";
      const workflow = await createQaTester({
        browserManagers: { demo: { browser, annotateFailures: true } },
        secretResolvers: { demo: () => secret },
        testDataRegistries: { demo: testDataRegistry },
        evidencePolicies: { demo: { safety: { screenshot: "required", console: "required", network: "required", logs: "required", trace: "required" }, ...(protectedEnvironment ? { protection: { protectedEnvironment: true, domSelectors: ["input"], deterministicTelemetryScrubber: true } } : {}) } },
      })({ root, mode: "full", environmentProfile: environment, bundle, runtime: { browserManagerId: "demo", ...(resolveDemoSecret ? { secretResolverId: "demo" } : {}), testDataRegistryId: "demo", testDataHookIds: ["demo-owned-resource"], evidencePolicyId: "demo" } });
      const cleanupRun = await executeCleanupRun({
        root,
        sourceRunId: workflow.runId,
        execute: async (resource) => {
          if (resource.cleanupAction !== markerPath) throw new Error("Demo cleanup received an unexpected resource");
          await rm(markerPath, { force: true });
          cleanupStatuses.push("deleted");
          return { status: "deleted" as const };
        },
      });
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
        const evidenceByInstance = evidenceSummaries(artifacts, attempts);
        const screenshotEvidenceGaps = artifacts.filter((artifact) => artifact.record.type === "evidence-gap" && artifact.value.affectedClaim === "screenshot capture").map((artifact) => ({ attemptId: String(artifact.value.attemptId), reason: String(artifact.value.reason) }));
        const traceEvidenceGaps = artifacts.filter((artifact) => artifact.record.type === "evidence-gap" && artifact.value.affectedClaim === "trace capture").map((artifact) => ({ attemptId: String(artifact.value.attemptId), reason: String(artifact.value.reason) }));
        const cleanup = { status: cleanupRun.resources.every((resource) => resource.status === "cleaned") ? "COMPLETED" : "COMPLETED_WITH_FAILURES", resources: cleanupStatuses };
        const result: DemoResult = { root, run: { id: workflow.runId, status: metadata.status }, attempts, files, report: { releaseRecommendation: report.releaseRecommendation }, validation: workflow.validation, telemetry, evidenceByInstance, screenshotEvidenceGaps, traceEvidenceGaps, cleanup };
        const evidenceComplete = result.evidenceByInstance.length === testcase.matrix.length && result.evidenceByInstance.every((evidence) => {
          const channelCountsComplete = evidence.console === 1 && evidence.network === 1;
          if (resolveDemoSecret) return evidence.rawScreenshots === 0 && evidence.annotatedScreenshots === 0 && evidence.traces === 0 && channelCountsComplete;
          return evidence.rawScreenshots === 1
            && evidence.annotatedScreenshots === 1
            && evidence.traces === 1
            && channelCountsComplete
            && evidence.annotation.testCaseRevisionId === testcase.testCase.revisionId
            && evidence.annotation.testCaseInstanceId === evidence.instanceId
            && evidence.annotation.testResultRelated
            && evidence.annotation.locator.length > 0
            && evidence.annotation.label.length > 0;
        });
        const telemetryComplete = result.telemetry.consoleErrors.includes("QA_DEMO_CONSOLE_ERROR") && result.telemetry.failedRequests.includes("/api/demo-failure");
        const screenshotComplete = resolveDemoSecret
          ? result.screenshotEvidenceGaps.length === testcase.matrix.length && result.files.every((file) => !file.startsWith("screenshots/"))
          : result.screenshotEvidenceGaps.length === 0 && result.files.some((file) => file.startsWith("screenshots/raw/")) && result.files.some((file) => file.startsWith("screenshots/annotated/"));
        const traceComplete = resolveDemoSecret
          ? result.traceEvidenceGaps.length === testcase.matrix.length && result.files.every((file) => !file.startsWith("traces/"))
          : result.traceEvidenceGaps.length === 0 && result.files.some((file) => file.startsWith("traces/"));
        const valid = result.run.status === "COMPLETED_WITH_FAILURES"
          && result.attempts.length === testcase.matrix.length
          && result.attempts.every((attempt) => attempt.status === "FAILED" && attempt.classification === "PRODUCT_DEFECT")
          && result.report.releaseRecommendation === "NOT_READY"
          && result.validation.valid
          && telemetryComplete
          && result.cleanup.status === "COMPLETED"
          && evidenceComplete
          && screenshotComplete
          && traceComplete;
        if (!valid) throw new Error(`Intentional defect was not completely detected: ${JSON.stringify(result)}`);
        return result;
      } finally {
        await workspace.close();
      }
    } finally {
      await rm(markerPath, { force: true });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runDemo().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`QA Skills demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
