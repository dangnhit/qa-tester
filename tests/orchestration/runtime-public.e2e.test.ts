import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RunWorkspace } from "../../src/core/run-workspace.js";
import { createQaTester, type CanonicalPlanBundleRef } from "../../src/operations/run-workflow.js";
import { sha256Fingerprint } from "../../src/planning/testcase-revision.js";
import { TestDataHookRegistry } from "../../src/test-data/hooks.js";
import { serveBrowserFixture } from "../../fixtures/browser/server.js";

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

async function sourceBundle(root: string): Promise<CanonicalPlanBundleRef> {
  const source = await RunWorkspace.create({ root, mode: "plan", environmentProfile: environment });
  const requirement = await source.registerArtifactValue({ type: "requirement-analysis", relationships: [], value: {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-RUNTIME",
    statements: [{ requirementId: "REQ-RUNTIME", sourceProvenance: { kind: "user", reference: "runtime-e2e" }, normalizedText: "Member must be able to save an email.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] }],
  } });
  const execution = dsl();
  const plan = await source.registerArtifactValue({ type: "test-plan", relationships: [requirement.id], value: {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-RUNTIME", approvalPolicy: { mode: "auto-approve-safe" },
    testCases: [{ testCaseId: "TC-RUNTIME", title: "Save email", expectedResults: [{ id: "ER-RUNTIME", requirementId: "REQ-RUNTIME", authority: "AUTHORITATIVE", text: "Saved" }], steps: [{ id: "plan-open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [], browserExecution: { revisionId: "REV-RUNTIME", instanceId: "INSTANCE-RUNTIME", browserDsl: execution, browserDslFingerprint: sha256Fingerprint(execution) } }],
  } });
  const testcase = await source.registerArtifactValue({ type: "test-case", relationships: [plan.id], value: {
    artifactType: "test-case", schemaVersion: "1.0.0", producerVersion: "1.0.0", testCaseId: "TC-RUNTIME", revisionId: "REV-RUNTIME", instanceId: "INSTANCE-RUNTIME", title: "Save email", steps: [{ id: "plan-open", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ-RUNTIME", role: "member", behavior: "save email", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
  } });
  const coverage = await source.registerArtifactValue({ type: "coverage-obligation", relationships: [requirement.id], value: {
    artifactType: "coverage-obligation", schemaVersion: "1.0.0", producerVersion: "1.0.0", obligationId: "COV-RUNTIME", requirementAnalysisArtifactId: requirement.id, requirementId: "REQ-RUNTIME", role: "member", behavior: "save email", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved", required: true,
  } });
  await source.finalize("plan");
  const records = await Promise.all([requirement, plan, testcase, coverage].map((artifact) => source.readArtifactRecord(artifact.id)));
  await source.close();
  return { sourceRunId: source.runId, artifacts: records.map((artifact) => ({ artifactId: artifact.id, sha256: artifact.sha256 })) };
}

describe("public runtime QA Tester", () => {
  it("fails before finalization without a configured runtime and leaves no fabricated result or report", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-runtime-missing-")); roots.push(root);
    const bundle = await sourceBundle(root);

    await expect(createQaTester({})({ root, mode: "full", environmentProfile: environment, bundle, runtime: {} })).rejects.toThrow(/runtime.*configured|configured.*runtime/i);

    const runIds = await readdir(join(root, "qa-results"));
    expect(runIds).toHaveLength(2);
    const targetRunId = runIds.find((runId) => runId !== bundle.sourceRunId);
    expect(targetRunId).toBeTruthy();
    const metadata = JSON.parse(await readFile(join(root, "qa-results", targetRunId!, "run-metadata.json"), "utf8")) as { status: string };
    expect(metadata.status).not.toMatch(/COMPLETED|BLOCKED|ABORTED/);
    const workspace = await RunWorkspace.open(root, targetRunId!);
    const artifacts = await workspace.readRegisteredArtifacts();
    expect(artifacts.some((item) => item.record.type === "test-result" || item.record.type === "qa-execution-report")).toBe(false);
    await workspace.close();
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
    expect(result.outputs.get("ingest-coverage-obligation")).toMatchObject({ complete: true, satisfied: ["COV-RUNTIME"] });
    expect(artifacts.some((item) => item.record.type === "release-gate")).toBe(true);
    expect(artifacts.some((item) => item.record.type === "qa-execution-report")).toBe(true);
    await workspace.close();
  });
});
