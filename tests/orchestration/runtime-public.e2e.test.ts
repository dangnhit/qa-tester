import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

import { RunWorkspace } from "../../src/core/run-workspace.js";
import { createQaTester, createQaTesterWithTraceForTests, type CanonicalPlanBundleRef } from "../../src/operations/run-workflow.js";
import { generateBugReport } from "../../src/operations/generate-bug-report.js";
import { sha256Fingerprint } from "../../src/planning/testcase-revision.js";
import { TestDataHookRegistry } from "../../src/test-data/hooks.js";
import { serveBrowserFixture } from "../../fixtures/browser/server.js";
import { sha256Text } from "../../src/core/checksum.js";

const roots: string[] = [];
const environment = { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "ENV-RUNTIME", name: "Runtime fixture", classification: "test", baseUrl: "http://fixture.invalid", productionReadOnly: false } as const;
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

function dsl() {
  return { steps: [
    { id: "open", action: { kind: "open", url: baseUrl }, sideEffect: "none" },
    { id: "fill", action: { kind: "fill", locator: { label: "Email" }, value: "qa@example.test" }, assertions: [{ kind: "value", locator: { label: "Email" }, value: "qa@example.test" }], sideEffect: "none" },
    { id: "save", action: { kind: "click", locator: { role: "button", name: "Save" } }, assertions: [{ kind: "text", locator: { testId: "result" }, text: "Saved" }], sideEffect: "none" },
  ] } as const;
}

async function sourceBundle(root: string, options: { sourceBug?: boolean | "intermittent" | "partial"; includeExcluded?: boolean } = {}): Promise<CanonicalPlanBundleRef & { sourceBug?: { artifactId: string; sha256: string; bugId: string } }> {
  const source = await RunWorkspace.create({ root, mode: options.sourceBug ? "execute" : "plan", environmentProfile: environment });
  const requirement = await source.registerArtifactValue({ type: "requirement-analysis", relationships: [], value: {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-RUNTIME",
    statements: [{ requirementId: "REQ-RUNTIME", sourceProvenance: { kind: "user", reference: "runtime-e2e" }, normalizedText: "Member must be able to save an email.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] }],
  } });
  const execution = dsl();
  const failingExecution = { steps: execution.steps.map((step) => step.id === "save" ? { ...step, assertions: [{ kind: "text" as const, locator: { testId: "result" }, text: "Broken" }] } : step) };
  const plan = await source.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-RUNTIME", approvalPolicy: { mode: "auto-approve-safe" },
    testCases: [
      { testCaseId: "TC-RUNTIME", title: "Save email", expectedResults: [{ id: "ER-RUNTIME", requirementId: "REQ-RUNTIME", authority: "AUTHORITATIVE", text: "Saved" }], steps: [{ id: "plan-open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [], browserExecution: { revisionId: "REV-RUNTIME", instanceId: "INSTANCE-RUNTIME", browserDsl: execution, browserDslFingerprint: sha256Fingerprint(execution) } },
      ...(options.sourceBug === "partial" ? [{ testCaseId: "TC-RUNTIME", title: "Save email second instance", expectedResults: [{ id: "ER-RUNTIME-2", requirementId: "REQ-RUNTIME", authority: "AUTHORITATIVE", text: "Broken" }], steps: [{ id: "plan-open-2", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [], browserExecution: { revisionId: "REV-RUNTIME", instanceId: "INSTANCE-RUNTIME-SECOND", browserDsl: failingExecution, browserDslFingerprint: sha256Fingerprint(failingExecution) } }] : []),
      ...(options.includeExcluded ? [{ testCaseId: "TC-EXCLUDED", title: "Excluded browser case", expectedResults: [{ id: "ER-EXCLUDED", requirementId: "REQ-RUNTIME", authority: "AUTHORITATIVE", text: "Saved" }], steps: [{ id: "plan-open-excluded", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [], browserExecution: { revisionId: "REV-EXCLUDED", instanceId: "INSTANCE-EXCLUDED", browserDsl: execution, browserDslFingerprint: sha256Fingerprint(execution) } }] : []),
    ],
  } });
  const testcase = await source.registerArtifactValue({ type: "test-case", relationships: [plan.id], value: {
    artifactType: "test-case", schemaVersion: "1.0.0", producerVersion: "1.0.0", testCaseId: "TC-RUNTIME", revisionId: "REV-RUNTIME", instanceId: "INSTANCE-RUNTIME", title: "Save email", steps: [{ id: "plan-open", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ-RUNTIME", role: "member", behavior: "save email", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
  } });
  const excluded = options.includeExcluded ? await source.registerArtifactValue({ type: "test-case", relationships: [plan.id], value: {
    artifactType: "test-case", schemaVersion: "1.0.0", producerVersion: "1.0.0", testCaseId: "TC-EXCLUDED", revisionId: "REV-EXCLUDED", instanceId: "INSTANCE-EXCLUDED", title: "Excluded browser case", steps: [{ id: "plan-open-excluded", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ-RUNTIME", role: "member", behavior: "excluded", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" }, regressionIndex: { requirementIds: [], codeSurfaces: ["excluded-surface"], declaredDependencies: [], gitPaths: [], userScope: [] },
  } }) : undefined;
  const second = options.sourceBug === "partial" ? await source.registerArtifactValue({ type: "test-case", relationships: [plan.id], value: { artifactType: "test-case", schemaVersion: "1.0.0", producerVersion: "1.0.0", testCaseId: "TC-RUNTIME", revisionId: "REV-RUNTIME", instanceId: "INSTANCE-RUNTIME-SECOND", title: "Save email second instance", steps: [{ id: "plan-open-2", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ-RUNTIME", role: "member", behavior: "save email second", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Broken" } } }) : undefined;
  const coverage = await source.registerArtifactValue({ type: "coverage-obligation", relationships: [requirement.id], value: {
    artifactType: "coverage-obligation", schemaVersion: "1.0.0", producerVersion: "1.0.0", obligationId: "COV-RUNTIME", requirementAnalysisArtifactId: requirement.id, requirementId: "REQ-RUNTIME", role: "member", behavior: "save email", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved", required: true,
  } });
  let sourceBug: { artifactId: string; sha256: string; bugId: string } | undefined;
  if (options.sourceBug) {
  const sourceSteps = [{ stepId: "open", status: "PASSED", durationMs: 1 }, { stepId: "fill", status: "PASSED", durationMs: 1 }, { stepId: "save", status: "FAILED", durationMs: 1, failureOrigin: "assertion", expectedResultId: "ER-RUNTIME" }] as const;
  const sourceAttempt = await source.registerArtifactValue({ type: "test-result", relationships: [testcase.id], value: { artifactType: "test-result", schemaVersion: "1.0.0", producerVersion: "1.0.0", attemptId: "ATT-SOURCE-BUG", runId: source.runId, testCaseId: "TC-RUNTIME", testCaseRevisionId: "REV-RUNTIME", testCaseInstanceId: "INSTANCE-RUNTIME", status: "FAILED", failureClassification: "PRODUCT_DEFECT", steps: sourceSteps, startedAt: "2026-07-23T00:00:00.000Z", finishedAt: "2026-07-23T00:01:00.000Z" } });
  if (options.sourceBug === "intermittent") await source.registerArtifactValue({ type: "test-result", relationships: [testcase.id], value: { artifactType: "test-result", schemaVersion: "1.0.0", producerVersion: "1.0.0", attemptId: "ATT-SOURCE-BUG-REPEAT", runId: source.runId, testCaseId: "TC-RUNTIME", testCaseRevisionId: "REV-RUNTIME", testCaseInstanceId: "INSTANCE-RUNTIME", status: "FAILED", failureClassification: "PRODUCT_DEFECT", steps: sourceSteps, startedAt: "2026-07-23T00:02:00.000Z", finishedAt: "2026-07-23T00:03:00.000Z" } });
    if (options.sourceBug === "partial" && second) await source.registerArtifactValue({ type: "test-result", relationships: [second.id], value: { artifactType: "test-result", schemaVersion: "1.0.0", producerVersion: "1.0.0", attemptId: "ATT-SOURCE-BUG-SECOND", runId: source.runId, testCaseId: "TC-RUNTIME", testCaseRevisionId: "REV-RUNTIME", testCaseInstanceId: "INSTANCE-RUNTIME-SECOND", status: "FAILED", failureClassification: "PRODUCT_DEFECT", steps: sourceSteps, startedAt: "2026-07-23T00:02:00.000Z", finishedAt: "2026-07-23T00:03:00.000Z" } });
    await source.registerEvidenceBundle({ binaries: [{ filename: "source-bug.txt", contents: Buffer.from("source browser failure"), mediaType: "text/plain", captureType: "log" }], relationships: [sourceAttempt.id], descriptor: (binaries) => ({ artifactType: "evidence", schemaVersion: "1.0.0", producerVersion: "1.0.0", evidenceId: "01K0ABCDEFGHJKMNPQRSTVWXYZ", runId: source.runId, attemptId: "ATT-SOURCE-BUG", testCaseId: "TC-RUNTIME", testCaseRevisionId: "REV-RUNTIME", testCaseInstanceId: "INSTANCE-RUNTIME", kind: "log", capturedAt: "2026-07-23T00:01:00.000Z", sha256: binaries[0]!.sha256, relativePath: binaries[0]!.relativePath, mediaType: "text/plain", binaryArtifactIds: binaries.map((binary) => binary.id), binaryArtifacts: binaries.map((binary) => ({ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType })), telemetryFindings: [{ kind: "console", level: "error", message: "source browser failure" }], provenance: { captureType: "log", dimensions: { width: 1, height: 1 }, dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 1, height: 1 }, url: baseUrl, viewport: { width: 1, height: 1 }, browser: "chromium", build: "fixture", capturedAt: "2026-07-23T00:01:00.000Z", testcaseId: "TC-RUNTIME" } }) });
    const generated = await generateBugReport({ workspace: source, attemptId: "ATT-SOURCE-BUG", unsafeRerunReason: "Source fixture preserves a single captured production defect observation." });
    if (generated.kind !== "BUG") throw new Error("Expected source product bug");
    sourceBug = { artifactId: generated.record.id, sha256: generated.record.sha256, bugId: String((await source.readRegisteredArtifacts()).find((item) => item.record.id === generated.record.id)?.value.bugId) };
  }
  await source.finalize(options.sourceBug ? "execute" : "plan");
  const records = await Promise.all([requirement, plan, testcase, coverage, ...(excluded === undefined ? [] : [excluded]), ...(second === undefined ? [] : [second])].map((artifact) => source.readArtifactRecord(artifact.id)));
  await source.close();
  return { sourceRunId: source.runId, artifacts: records.map((artifact) => ({ artifactId: artifact.id, sha256: artifact.sha256 })), ...(sourceBug === undefined ? {} : { sourceBug }) };
}

async function alternatingFixture(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  let visits = 0;
  const server = createServer((_request, response) => {
    visits += 1;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><label>Email <input aria-label="Email" /></label><button>Save</button><output data-testid="result"></output><script>document.querySelector('button').onclick=()=>document.querySelector('output').textContent='${visits % 2 === 1 ? "Saved" : "Broken"}'</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("fixture address unavailable");
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))) };
}

async function rechecksumRegisteredArtifact(workspace: RunWorkspace, artifactId: string, mutate: (value: Record<string, unknown>) => void): Promise<void> {
  const record = await workspace.readArtifactRecord(artifactId);
  const artifactPath = await workspace.resolve(record.relativePath);
  const value = JSON.parse(await readFile(artifactPath, "utf8")) as Record<string, unknown>;
  mutate(value);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(artifactPath, contents);
  const manifestPath = join(workspace.path, "artifact-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; sha256: string }[] };
  const manifestRecord = manifest.artifacts.find((item) => item.id === artifactId);
  if (!manifestRecord) throw new Error("Expected manifest artifact");
  manifestRecord.sha256 = sha256Text(contents);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

describe("public runtime QA Tester", () => {
  it("checkpoints a missing runtime as AWAITING_RUNTIME and resumes the same nonterminal run without fabricating a result or report", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-runtime-missing-")); roots.push(root);
    const bundle = await sourceBundle(root);

    const waiting = await createQaTester({})({ root, mode: "full", environmentProfile: environment, bundle, runtime: {} });
    expect(waiting.outcome).toBe("AWAITING_RUNTIME");

    const runIds = await readdir(join(root, "qa-results"));
    expect(runIds).toHaveLength(2);
    const targetRunId = runIds.find((runId) => runId !== bundle.sourceRunId);
    expect(targetRunId).toBeTruthy();
    if (!targetRunId) throw new Error("Expected checkpointed target run");
    const metadata = JSON.parse(await readFile(join(root, "qa-results", targetRunId, "run-metadata.json"), "utf8")) as { status: string };
    expect(metadata.status).not.toMatch(/COMPLETED|BLOCKED|ABORTED/);
    const workspace = await RunWorkspace.open(root, targetRunId);
    const artifacts = await workspace.readRegisteredArtifacts();
    expect(artifacts.some((item) => item.record.type === "workflow-checkpoint")).toBe(true);
    expect(artifacts.some((item) => item.record.type === "test-result" || item.record.type === "qa-execution-report")).toBe(false);
    await workspace.close();

    const resumed = await createQaTester({ browserManagers: { chromium: { browser } }, testDataRegistries: { trusted: new TestDataHookRegistry([], {}) }, evidencePolicies: { required: { safety: { screenshot: "required", console: "required", network: "off", logs: "required" } } } })({ root, mode: "full", resumeRunId: targetRunId, environmentProfile: environment, bundle, runtime: { browserManagerId: "chromium", testDataRegistryId: "trusted", evidencePolicyId: "required" } });
    expect(resumed.runId).toBe(targetRunId);
    expect(resumed.outcome).toBe("COMPLETED");
  });

  it("runs a full lifecycle through a real Chromium browser and only finalizes registered evidence-backed artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-runtime-public-")); roots.push(root);
    const bundle = await sourceBundle(root);
    const tester = createQaTester({ browserManagers: { chromium: { browser } }, testDataRegistries: { trusted: new TestDataHookRegistry([], {}) }, evidencePolicies: { required: { safety: { screenshot: "required", console: "required", network: "off", logs: "required" } } } });

    const result = await tester({ root, mode: "full", environmentProfile: environment, bundle, runtime: { browserManagerId: "chromium", testDataRegistryId: "trusted", evidencePolicyId: "required" } });
    const workspace = await RunWorkspace.open(root, result.runId);
    const artifacts = await workspace.readRegisteredArtifacts();

    expect(result.operationOrder).toEqual(["ingest-requirement-analysis", "ingest-testcases", "ingest-coverage-obligation", "prepare-test-data", "execute-browser-test", "collect-evidence", "generate-bug-report", "generate-qa-report"]);
    expect(result.validation.valid).toBe(true);
    expect(artifacts.filter((item) => item.record.type === "test-result").map((item) => item.value.status)).toEqual(["PASSED"]);
    expect(artifacts.some((item) => item.record.type === "evidence" && item.value.provenance && (item.value.provenance as { testcaseId?: string }).testcaseId === "TC-RUNTIME")).toBe(true);
    expect(artifacts.some((item) => item.record.type === "test-data-manifest")).toBe(true);
    expect(result.outputs["ingest-coverage-obligation"]).toEqual([expect.objectContaining({ type: "coverage-obligation" })]);
    expect(artifacts.some((item) => item.record.type === "release-gate")).toBe(true);
    expect(artifacts.some((item) => item.record.type === "qa-execution-report")).toBe(true);
    await workspace.close();
  });

  it("rejects a runtime execution whose adapter supplies no declared case-bound evidence artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-runtime-postcondition-")); roots.push(root);
    const bundle = await sourceBundle(root);
    const tester = createQaTester({ browserManagers: { chromium: { browser } }, evidencePolicies: { none: { safety: { screenshot: "off", console: "off", network: "off", logs: "off" } } } });

    await expect(tester({ root, mode: "execute", environmentProfile: environment, bundle, runtime: { browserManagerId: "chromium", evidencePolicyId: "none" } })).rejects.toThrow(/postcondition.*result.*evidence|result.*evidence/i);
    const runIds = await readdir(join(root, "qa-results"));
    const runId = runIds.find((id) => id !== bundle.sourceRunId)!;
    const workspace = await RunWorkspace.open(root, runId);
    const artifacts = await workspace.readRegisteredArtifacts();
    expect(artifacts.some((item) => item.record.type === "test-result")).toBe(true);
    expect(artifacts.some((item) => item.record.type === "evidence" || item.record.type === "evidence-gap" || item.record.type === "qa-execution-report")).toBe(false);
    await workspace.close();
  });

  it("iterates the exact operation plan once, invokes each closed postcondition once, and resumes after a failed postcondition at the same operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-runtime-adapter-loop-")); roots.push(root);
    const bundle = await sourceBundle(root);
    const firstTrace: string[] = [];
    const first = createQaTesterWithTraceForTests({ browserManagers: { chromium: { browser } }, testDataRegistries: { trusted: new TestDataHookRegistry([], {}) }, evidencePolicies: { none: { safety: { screenshot: "off", console: "off", network: "off", logs: "off" } } } }, (event) => firstTrace.push(event));
    await expect(first({ root, mode: "full", environmentProfile: environment, bundle, runtime: { browserManagerId: "chromium", testDataRegistryId: "trusted", evidencePolicyId: "none" } })).rejects.toThrow(/evidence/i);
    expect(firstTrace).toEqual([
      "ingest-requirement-analysis:adapter", "ingest-requirement-analysis:postcondition",
      "ingest-testcases:adapter", "ingest-testcases:postcondition",
      "ingest-coverage-obligation:adapter", "ingest-coverage-obligation:postcondition",
      "prepare-test-data:adapter", "prepare-test-data:postcondition",
      "execute-browser-test:adapter", "execute-browser-test:postcondition",
    ]);
    const runId = (await readdir(join(root, "qa-results"))).find((id) => id !== bundle.sourceRunId)!;
    const resumedTrace: string[] = [];
    const resumed = createQaTesterWithTraceForTests({ browserManagers: { chromium: { browser } }, testDataRegistries: { trusted: new TestDataHookRegistry([], {}) }, evidencePolicies: { required: { safety: { screenshot: "required", console: "off", network: "off", logs: "off" } } } }, (event) => resumedTrace.push(event));
    const result = await resumed({ root, mode: "full", resumeRunId: runId, environmentProfile: environment, bundle, runtime: { browserManagerId: "chromium", testDataRegistryId: "trusted", evidencePolicyId: "required" } });
    expect(result.operationOrder).toEqual(["ingest-requirement-analysis", "ingest-testcases", "ingest-coverage-obligation", "prepare-test-data", "execute-browser-test", "collect-evidence", "generate-bug-report", "generate-qa-report"]);
    expect(resumedTrace).toEqual([
      "ingest-requirement-analysis:postcondition",
      "ingest-testcases:postcondition",
      "ingest-coverage-obligation:postcondition",
      "prepare-test-data:postcondition",
      "execute-browser-test:adapter", "execute-browser-test:postcondition",
      "collect-evidence:adapter", "collect-evidence:postcondition",
      "generate-bug-report:adapter", "generate-bug-report:postcondition",
      "generate-qa-report:adapter", "generate-qa-report:postcondition",
    ]);
  });

  it("derives protected screenshot redaction from the registered environment and records a gap instead of pixels when it cannot verify it", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-runtime-protected-")); roots.push(root);
    const bundle = await sourceBundle(root);
    const protectedEnvironment = { ...environment, environmentProfileId: "ENV-PROTECTED", evidenceProtection: { protected: true } } as const;
    const tester = createQaTester({
      browserManagers: { chromium: { browser } },
      evidencePolicies: { required: { safety: { screenshot: "required", console: "off", network: "off", logs: "required" } } },
    });

    const result = await tester({ root, mode: "execute", environmentProfile: protectedEnvironment, bundle, runtime: { browserManagerId: "chromium", evidencePolicyId: "required" } });
    const workspace = await RunWorkspace.open(root, result.runId);
    const artifacts = await workspace.readRegisteredArtifacts();

    expect(artifacts.filter((item) => item.record.type === "evidence-gap").map((item) => item.value.reason)).toContain("Protected screenshot capture requires a verifiable redaction policy");
    expect(artifacts.some((item) => item.record.type === "evidence" && item.value.kind === "screenshot")).toBe(false);
    await workspace.close();
  });

  it("records required video as an evidence gap and makes the deterministic full release gate NOT_READY", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-runtime-video-gap-")); roots.push(root);
    const bundle = await sourceBundle(root);
    const tester = createQaTester({
      browserManagers: { chromium: { browser } },
      testDataRegistries: { trusted: new TestDataHookRegistry([], {}) },
      evidencePolicies: { video: { safety: { screenshot: "required", console: "off", network: "off", logs: "required", video: "required" } } },
    });

    const result = await tester({ root, mode: "full", environmentProfile: environment, bundle, runtime: { browserManagerId: "chromium", testDataRegistryId: "trusted", evidencePolicyId: "video" } });
    const workspace = await RunWorkspace.open(root, result.runId);
    const artifacts = await workspace.readRegisteredArtifacts();

    expect(artifacts.filter((item) => item.record.type === "evidence-gap").map((item) => item.value.reason))
      .toContain("Required video capture is unsupported by the active browser manager");
    expect(artifacts.find((item) => item.record.type === "release-gate")?.value.recommendation).toBe("NOT_READY");
    await workspace.close();
  });

  it("imports a terminal bundle for regression, executes only checksum-bound selected cases, and preserves its source bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-runtime-regression-")); roots.push(root);
    const bundle = await sourceBundle(root, { includeExcluded: true });
    const sourceManifestPath = join(root, "qa-results", bundle.sourceRunId, "artifact-manifest.json");
    const sourceBytes = await readFile(sourceManifestPath);
    const tester = createQaTester({
      browserManagers: { chromium: { browser } },
      evidencePolicies: { required: { safety: { screenshot: "required", console: "required", network: "off", logs: "required" } } },
      changeScopeSources: { trusted: { changes: [{ id: "CHANGE-SAVE", requirementIds: ["REQ-RUNTIME"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }, { id: "CHANGE-UNMAPPED", requirementIds: ["REQ-NONE"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }], provenance: { kind: "git-diff", reference: "abc..def" } } },
    });

    const result = await tester({ root, mode: "regression", environmentProfile: environment, bundle, runtime: { browserManagerId: "chromium", evidencePolicyId: "required", changeScopeSourceId: "trusted" } });
    const workspace = await RunWorkspace.open(root, result.runId);
    const artifacts = await workspace.readRegisteredArtifacts();
    const selection = artifacts.find((item) => item.record.type === "regression-selection");
    const attempts = artifacts.filter((item) => item.record.type === "test-result");

    expect(result.operationOrder).toEqual(["select-regression", "execute-browser-test", "collect-evidence", "generate-bug-report", "generate-qa-report"]);
    expect(selection?.value).toMatchObject({ complete: false, selected: [{ testCaseId: "TC-RUNTIME", revisionId: "REV-RUNTIME" }], excluded: [{ testCaseId: "TC-EXCLUDED", revisionId: "REV-EXCLUDED" }], unmappedChangeRisks: [{ changeId: "CHANGE-UNMAPPED" }] });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.value).toMatchObject({ testCaseId: "TC-RUNTIME", testCaseRevisionId: "REV-RUNTIME", status: "PASSED" });
    expect(artifacts.filter((item) => item.record.type === "evidence").every((item) => (item.value.provenance as { testcaseId?: string }).testcaseId === "TC-RUNTIME")).toBe(true);
    expect(artifacts.some((item) => item.record.type === "qa-execution-report")).toBe(true);
    expect(result.validation.valid).toBe(true);
    expect(await readFile(sourceManifestPath)).toEqual(sourceBytes);
    await workspace.close();
  });

  it("rejects a rechecksummed regression checkpoint that replaces the selected execution case with an excluded case", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-runtime-regression-checkpoint-tamper-")); roots.push(root);
    const bundle = await sourceBundle(root, { includeExcluded: true });
    const tester = createQaTester({
      browserManagers: { chromium: { browser } },
      evidencePolicies: { required: { safety: { screenshot: "required", console: "off", network: "off", logs: "required" } } },
      changeScopeSources: { trusted: { changes: [{ id: "CHANGE-SAVE", requirementIds: ["REQ-RUNTIME"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }], provenance: { kind: "git-diff", reference: "checkpoint-tamper" } } },
    });
    const result = await tester({ root, mode: "regression", environmentProfile: environment, bundle, runtime: { browserManagerId: "chromium", evidencePolicyId: "required", changeScopeSourceId: "trusted" } });
    const workspace = await RunWorkspace.open(root, result.runId);
    const artifacts = await workspace.readRegisteredArtifacts();
    const checkpoint = artifacts.find((artifact) => artifact.record.type === "workflow-checkpoint" && JSON.stringify(artifact.value.completedOperations) === JSON.stringify(["select-regression"]));
    const excluded = artifacts.find((artifact) => artifact.record.type === "test-case" && artifact.value.testCaseId === "TC-EXCLUDED");
    if (!checkpoint || !excluded) throw new Error("Expected selected checkpoint and excluded testcase");
    await rechecksumRegisteredArtifact(workspace, checkpoint.record.id, (value) => {
      const state = value.state as Record<string, unknown>;
      state.executionCases = [{ artifactId: excluded.record.id, sha256: excluded.record.sha256 }];
      value.stateChecksum = sha256Text(canonicalJson(state));
    });
    await workspace.close();
    await expect(RunWorkspace.open(root, result.runId)).rejects.toThrow(/checkpoint|selection|execution|binding/i);
  });

  it("rejects a rechecksummed regression checkpoint that reorders two valid selected execution cases", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-runtime-regression-checkpoint-order-")); roots.push(root);
    const bundle = await sourceBundle(root, { sourceBug: "partial" });
    const tester = createQaTester({
      browserManagers: { chromium: { browser } },
      evidencePolicies: { required: { safety: { screenshot: "required", console: "off", network: "off", logs: "required" } } },
      changeScopeSources: { trusted: { changes: [{ id: "CHANGE-SAVE", requirementIds: ["REQ-RUNTIME"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }], provenance: { kind: "git-diff", reference: "checkpoint-order" } } },
    });
    const result = await tester({ root, mode: "regression", environmentProfile: environment, bundle, runtime: { browserManagerId: "chromium", evidencePolicyId: "required", changeScopeSourceId: "trusted" } });
    const workspace = await RunWorkspace.open(root, result.runId);
    const checkpoint = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "workflow-checkpoint" && JSON.stringify(artifact.value.completedOperations) === JSON.stringify(["select-regression"]));
    if (!checkpoint) throw new Error("Expected selected checkpoint");
    await rechecksumRegisteredArtifact(workspace, checkpoint.record.id, (value) => {
      const state = value.state as Record<string, unknown>;
      const cases = state.executionCases as unknown[];
      if (cases.length !== 2) throw new Error("Expected two selected canonical cases");
      state.executionCases = [...cases].reverse();
      value.stateChecksum = sha256Text(canonicalJson(state));
    });
    await workspace.close();
    await expect(RunWorkspace.open(root, result.runId)).rejects.toThrow(/checkpoint|selection|execution|binding/i);
  });

  it("retests an immutable source bug before independent regression and derives FIXED from registered attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-runtime-retest-")); roots.push(root);
    const bundle = await sourceBundle(root, { sourceBug: true });
    if (!bundle.sourceBug) throw new Error("Expected source bug reference");
    const sourceManifestPath = join(root, "qa-results", bundle.sourceRunId, "artifact-manifest.json");
    const sourceBytes = await readFile(sourceManifestPath);
    const tester = createQaTester({
      browserManagers: { chromium: { browser } },
      evidencePolicies: { required: { safety: { screenshot: "required", console: "required", network: "off", logs: "required" } } },
      changeScopeSources: { trusted: { changes: [{ id: "CHANGE-SAVE", requirementIds: ["REQ-RUNTIME"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }], provenance: { kind: "git-diff", reference: "fix..head" } } },
    });

    const result = await tester({ root, mode: "retest", linkedRunId: bundle.sourceRunId, environmentProfile: environment, bundle, runtime: { browserManagerId: "chromium", evidencePolicyId: "required", changeScopeSourceId: "trusted" }, retest: { sourceBug: { artifactId: bundle.sourceBug.artifactId, sha256: bundle.sourceBug.sha256 } } });
    const workspace = await RunWorkspace.open(root, result.runId);
    const artifacts = await workspace.readRegisteredArtifacts();
    const attempts = artifacts.filter((item) => item.record.type === "test-result");
    const retest = artifacts.find((item) => item.record.type === "retest-result");

    expect(result.operationOrder).toEqual(["reproduce-bug", "select-regression", "execute-browser-test", "collect-evidence", "generate-bug-report", "derive-retest-verdict"]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.value).toMatchObject({ testCaseId: "TC-RUNTIME", testCaseRevisionId: "REV-RUNTIME", testCaseInstanceId: "INSTANCE-RUNTIME", status: "PASSED" });
    expect(retest?.value).toMatchObject({ sourceRunId: bundle.sourceRunId, sourceBugArtifactId: bundle.sourceBug.artifactId, sourceBugArtifactSha256: bundle.sourceBug.sha256, bugId: bundle.sourceBug.bugId, verdict: "FIXED", regressionOutcome: "NOT_RUN" });
    expect(await readFile(sourceManifestPath)).toEqual(sourceBytes);
    await workspace.close();
  });

  it("replays repeated source occurrences in real Chromium and durably derives INTERMITTENT", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-runtime-intermittent-")); roots.push(root);
    const alternating = await alternatingFixture();
    const savedBaseUrl = baseUrl; baseUrl = alternating.baseUrl;
    try {
      const bundle = await sourceBundle(root, { sourceBug: "intermittent" });
      if (!bundle.sourceBug) throw new Error("Expected source bug");
      const tester = createQaTester({ browserManagers: { chromium: { browser } }, evidencePolicies: { required: { safety: { screenshot: "required", console: "off", network: "off", logs: "off" } } }, changeScopeSources: { trusted: { changes: [{ id: "CHANGE-SAVE", requirementIds: ["REQ-RUNTIME"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }], provenance: { kind: "git-diff", reference: "intermittent" } } } });
      const result = await tester({ root, mode: "retest", linkedRunId: bundle.sourceRunId, environmentProfile: { ...environment, baseUrl }, bundle, runtime: { browserManagerId: "chromium", evidencePolicyId: "required", changeScopeSourceId: "trusted" }, retest: { sourceBug: bundle.sourceBug } });
      const workspace = await RunWorkspace.open(root, result.runId);
      const retest = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "retest-result");
      expect(retest?.value).toMatchObject({ verdict: "INTERMITTENT" });
      expect((retest?.value.reproductionScenarios as unknown[])).toHaveLength(2);
      await workspace.close();
      const reopened = await RunWorkspace.open(root, result.runId); expect((await reopened.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "retest-result")?.value.verdict).toBe("INTERMITTENT"); await reopened.close();
    } finally { baseUrl = savedBaseUrl; await alternating.close(); }
  });

  it("replays two exact source instances before regression and durably derives PARTIALLY_FIXED", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-runtime-partial-")); roots.push(root);
    const bundle = await sourceBundle(root, { sourceBug: "partial" }); if (!bundle.sourceBug) throw new Error("Expected source bug");
    const sourceBytes = await readFile(join(root, "qa-results", bundle.sourceRunId, "artifact-manifest.json"));
    const tester = createQaTester({ browserManagers: { chromium: { browser } }, evidencePolicies: { required: { safety: { screenshot: "required", console: "off", network: "off", logs: "off" } } }, changeScopeSources: { trusted: { changes: [{ id: "CHANGE-SAVE", requirementIds: ["REQ-RUNTIME"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }], provenance: { kind: "git-diff", reference: "partial" } } } });
    const result = await tester({ root, mode: "retest", linkedRunId: bundle.sourceRunId, environmentProfile: { ...environment, baseUrl }, bundle, runtime: { browserManagerId: "chromium", evidencePolicyId: "required", changeScopeSourceId: "trusted" }, retest: { sourceBug: bundle.sourceBug } });
    const workspace = await RunWorkspace.open(root, result.runId);
    const retest = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "retest-result")!;
    const scenarios = retest.value.reproductionScenarios as { scenarioId: string; attemptId: string; sourceAttemptArtifactId: string; sourceTestCaseArtifactId: string; status: string }[];
    expect(retest.value.verdict).toBe("PARTIALLY_FIXED");
    expect(scenarios).toHaveLength(2); expect(new Set(scenarios.map((scenario) => scenario.scenarioId)).size).toBe(2); expect(new Set(scenarios.map((scenario) => scenario.sourceAttemptArtifactId)).size).toBe(2); expect(new Set(scenarios.map((scenario) => scenario.sourceTestCaseArtifactId)).size).toBe(2); expect(scenarios.map((scenario) => scenario.status).sort()).toEqual(["FAILED", "PASSED"]);
    const checkpoint = (await workspace.readRegisteredArtifacts()).filter((artifact) => artifact.record.type === "workflow-checkpoint").at(-1)!;
    expect(checkpoint.value.completedOperations).toEqual(["reproduce-bug", "select-regression", "execute-browser-test", "collect-evidence", "generate-bug-report", "derive-retest-verdict"]);
    await workspace.close(); expect(await readFile(join(root, "qa-results", bundle.sourceRunId, "artifact-manifest.json"))).toEqual(sourceBytes);
    const reopened = await RunWorkspace.open(root, result.runId); expect((await reopened.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "retest-result")?.value.verdict).toBe("PARTIALLY_FIXED"); await reopened.close();
  });

  it("rejects rechecksummed charter, regression-selection, and retest-verdict tampering on reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-runtime-tamper-")); roots.push(root);
    const bundle = await sourceBundle(root, { sourceBug: true });
    if (!bundle.sourceBug) throw new Error("Expected source bug reference");
    const runtime = {
      browserManagers: { chromium: { browser } },
      evidencePolicies: { required: { safety: { screenshot: "required", console: "required", network: "off", logs: "required" } } },
      changeScopeSources: { trusted: { changes: [{ id: "CHANGE-SAVE", requirementIds: ["REQ-RUNTIME"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }, { id: "CHANGE-UNMAPPED", requirementIds: ["REQ-NONE"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }], provenance: { kind: "git-diff", reference: "tamper..head" } } },
    } as const;
    const tester = createQaTester(runtime);

    const exploratory = await tester({ root, mode: "exploratory", environmentProfile: { ...environment, baseUrl }, runtime: { browserManagerId: "chromium", evidencePolicyId: "required" }, charter: { charterId: "CHAR-TAMPER", mission: "Explore save", scope: ["/"], roles: ["member"], heuristics: ["boundary"], safetyRules: ["fixture"], actions: [{ actionId: "open", target: "/", kind: "navigate", sideEffect: "none", safetyRuleId: "fixture" }], actionBudget: 1, timeBudgetMinutes: 1, stopConditions: ["budget"] } });
    expect(exploratory.validation.valid).toBe(true);
    const charterRunId = (await readdir(join(root, "qa-results"))).find((id) => id !== bundle.sourceRunId)!;
    const charterWorkspace = await RunWorkspace.open(root, charterRunId);
    const charter = (await charterWorkspace.readRegisteredArtifacts()).find((item) => item.record.type === "exploration-charter")!;
    expect((await charterWorkspace.readRegisteredArtifacts()).find((item) => item.record.type === "exploratory-finding")?.value).toMatchObject({ authority: "EXPLORATORY", satisfiesCoverage: false });
    await rechecksumRegisteredArtifact(charterWorkspace, charter.record.id, (value) => { value.actionBudget = 0; });
    await charterWorkspace.close();
    await expect(RunWorkspace.open(root, charterRunId)).rejects.toThrow(/contract|binding|invalid/i);

    const regression = await tester({ root, mode: "regression", environmentProfile: environment, bundle, runtime: { browserManagerId: "chromium", evidencePolicyId: "required", changeScopeSourceId: "trusted" } });
    const regressionWorkspace = await RunWorkspace.open(root, regression.runId);
    const selection = (await regressionWorkspace.readRegisteredArtifacts()).find((item) => item.record.type === "regression-selection")!;
    await rechecksumRegisteredArtifact(regressionWorkspace, selection.record.id, (value) => { value.complete = true; });
    await regressionWorkspace.close();
    await expect(RunWorkspace.open(root, regression.runId)).rejects.toThrow(/unmapped|complete|binding/i);

    const retest = await tester({ root, mode: "retest", linkedRunId: bundle.sourceRunId, environmentProfile: environment, bundle, runtime: { browserManagerId: "chromium", evidencePolicyId: "required", changeScopeSourceId: "trusted" }, retest: { sourceBug: { artifactId: bundle.sourceBug.artifactId, sha256: bundle.sourceBug.sha256 } } });
    const retestWorkspace = await RunWorkspace.open(root, retest.runId);
    const retestResult = (await retestWorkspace.readRegisteredArtifacts()).find((item) => item.record.type === "retest-result")!;
    await rechecksumRegisteredArtifact(retestWorkspace, retestResult.record.id, (value) => { value.verdict = "NOT_FIXED"; });
    await retestWorkspace.close();
    await expect(RunWorkspace.open(root, retest.runId)).rejects.toThrow(/verdict|retest|binding/i);

    for (const mutate of [
      (scenario: Record<string, unknown>) => { scenario.sourceTestCaseArtifactId = "forged-case"; },
      (scenario: Record<string, unknown>) => { scenario.sourceAttemptArtifactId = "forged-attempt"; },
      (scenario: Record<string, unknown>) => { scenario.scenarioId = "forged-scenario"; },
    ]) {
      const tampered = await tester({ root, mode: "retest", linkedRunId: bundle.sourceRunId, environmentProfile: environment, bundle, runtime: { browserManagerId: "chromium", evidencePolicyId: "required", changeScopeSourceId: "trusted" }, retest: { sourceBug: bundle.sourceBug } });
      const tamperedWorkspace = await RunWorkspace.open(root, tampered.runId);
      const result = (await tamperedWorkspace.readRegisteredArtifacts()).find((item) => item.record.type === "retest-result")!;
      await rechecksumRegisteredArtifact(tamperedWorkspace, result.record.id, (value) => mutate((value.reproductionScenarios as Record<string, unknown>[])[0]!));
      await tamperedWorkspace.close();
      await expect(RunWorkspace.open(root, tampered.runId)).rejects.toThrow(/retest|source|scenario|binding/i);
    }
  });

  it("enforces exploratory URL scope, side-effect safety, declared budgets, and stop conditions through the public Chromium adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-runtime-exploration-contract-")); roots.push(root);
    const tester = createQaTester({ browserManagers: { chromium: { browser } }, evidencePolicies: { required: { safety: { screenshot: "required", console: "off", network: "off", logs: "off" } } } });
    const base = { charterId: "CHAR-CONTRACT", mission: "Explore fixture", scope: ["/"], roles: ["member"], heuristics: ["boundary"], safetyRules: ["fixture"], actionBudget: 1, timeBudgetMinutes: 1, stopConditions: ["stop"] } as const;
    const input = { root, mode: "exploratory" as const, environmentProfile: { ...environment, baseUrl }, runtime: { browserManagerId: "chromium", evidencePolicyId: "required" } };

    await expect(tester({ ...input, charter: { ...base, actions: [{ actionId: "outside", target: "/outside", kind: "navigate", sideEffect: "none", safetyRuleId: "fixture" }] } })).rejects.toThrow(/outside.*scope/i);
    await expect(tester({ ...input, charter: { ...base, charterId: "CHAR-UNSAFE", actions: [{ actionId: "write", target: "/", kind: "navigate", sideEffect: "write", safetyRuleId: "fixture" }] } })).rejects.toThrow(/unsafe.*side effect/i);
    await expect(tester({ ...input, charter: { ...base, charterId: "CHAR-BUDGET", actions: [{ actionId: "one", target: "/", kind: "navigate", sideEffect: "none", safetyRuleId: "fixture" }, { actionId: "two", target: "/", kind: "navigate", sideEffect: "none", safetyRuleId: "fixture" }] } })).rejects.toThrow(/action list exceeds.*budget/i);

    const stopped = await tester({ ...input, charter: { ...base, charterId: "CHAR-STOP", actionBudget: 2, actions: [{ actionId: "first", target: "/", kind: "navigate", sideEffect: "none", safetyRuleId: "fixture", stopCondition: "stop" }, { actionId: "second", target: "/", kind: "navigate", sideEffect: "none", safetyRuleId: "fixture" }] } });
    const workspace = await RunWorkspace.open(root, stopped.runId);
    const finding = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "exploratory-finding");
    expect(finding?.value.observation).toMatch(/Navigation telemetry/);
    await workspace.close();
  });
});
