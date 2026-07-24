import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { activeBrowserSessions, executeTestInstance } from "../../src/operations/execute-browser-test.js";
import type { ActiveBrowserSession, BrowserTestStep } from "../../src/browser/types.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { sha256Fingerprint } from "../../src/planning/testcase-revision.js";
import { sha256Text } from "../../src/core/checksum.js";
import { serveBrowserFixture } from "../../fixtures/browser/server.js";
import { ExternalPermitRegistry } from "../../src/safety/external-permits.js";

const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "../../fixtures/browser/basic.html");
const roots: string[] = [];
let browser: Browser;
let baseUrl: string;
let closeServer: () => Promise<void>;

const environment = {
  artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0",
  environmentProfileId: "env-browser", name: "Browser fixture", classification: "test", baseUrl: "http://fixture.invalid", productionReadOnly: false,
} as const;

beforeAll(async () => {
  const fixtureServer = await serveBrowserFixture(fixture);
  baseUrl = fixtureServer.baseUrl;
  closeServer = () => fixtureServer.close();
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => { await browser?.close(); await closeServer?.(); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function browserDsl() {
  return { steps: [
    { id: "open", action: { kind: "open", url: baseUrl }, assertions: [{ kind: "console-policy", level: "warning", allow: ["fixture initialized"] }], sideEffect: "none" },
    { id: "fill", action: { kind: "fill", locator: { label: "Email" }, value: { secretRef: "browser-email" } }, assertions: [{ kind: "value", locator: { label: "Email" }, value: { secretRef: "browser-email" } }], sideEffect: "none" },
    { id: "click", action: { kind: "click", locator: { role: "button", name: "Save" } }, assertions: [{ kind: "text", locator: { testId: "result" }, text: "Saved" }], sideEffect: "none" },
  ] } satisfies { steps: readonly BrowserTestStep[] };
}

function requirement(authority: "AUTHORITATIVE" | "INFERRED" = "AUTHORITATIVE") {
  return {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-BROWSER",
    statements: [{ requirementId: "REQ-BROWSER", sourceProvenance: authority === "INFERRED" ? { kind: "code", reference: "controller.ts" } : { kind: "user", reference: "ticket-browser" }, normalizedText: "A member must be able to save an email.", authority, role: "member", rules: [], risks: [], assumptions: [], openQuestions: [] }],
  };
}

function plan(revisionId = "REV-BROWSER", instanceId = "INSTANCE-BROWSER", dsl: { steps: readonly BrowserTestStep[] } = browserDsl(), policy: "auto-approve-safe" | "human-review" = "auto-approve-safe", expectedAuthority: "AUTHORITATIVE" | "INFERRED" = "AUTHORITATIVE") {
  return {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN-BROWSER", approvalPolicy: { mode: policy },
    testCases: [{
      testCaseId: "TC-BROWSER", title: "Saves email", expectedResults: [{ id: "ER-BROWSER", requirementId: "REQ-BROWSER", authority: expectedAuthority, text: "The email is saved." }],
      steps: [{ id: "plan-open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [],
      browserExecution: { revisionId, instanceId, browserDsl: dsl, browserDslFingerprint: sha256Fingerprint(dsl) },
    }],
  };
}

function testCase(revisionId = "REV-BROWSER", instanceId = "INSTANCE-BROWSER") {
  return {
    artifactType: "test-case", schemaVersion: "1.0.0", producerVersion: "1.0.0", testCaseId: "TC-BROWSER", revisionId, instanceId, title: "Saves email",
    steps: [{ id: "plan-open", action: "navigate", sideEffect: "none" }],
    coverage: { requirementId: "REQ-BROWSER", role: "member", behavior: "save email", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "The email is saved." },
  };
}

async function governedWorkspace(options: { revisionId?: string; instanceId?: string; testCaseRevisionId?: string; testCaseInstanceId?: string; dsl?: { steps: readonly BrowserTestStep[] }; policy?: "auto-approve-safe" | "human-review"; expectedAuthority?: "AUTHORITATIVE" | "INFERRED"; decision?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), "qa-skills-browser-"));
  roots.push(root);
  const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
  await workspace.registerArtifactValue({ type: "requirement-analysis", value: requirement(options.expectedAuthority), relationships: [] });
  const planValue = plan(options.revisionId, options.instanceId, options.dsl, options.policy, options.expectedAuthority);
  if (options.decision !== undefined) Object.assign(planValue, { approvalDecision: options.decision });
  const registeredPlan = await workspace.registerArtifactValue({ type: "test-plan", value: planValue, relationships: [] });
  const registeredCase = await workspace.registerArtifactValue({ type: "test-case", value: testCase(options.testCaseRevisionId ?? options.revisionId, options.testCaseInstanceId ?? options.instanceId), relationships: [registeredPlan.id] });
  return { workspace, registeredPlan, registeredCase };
}

async function rechecksumArtifact(workspace: RunWorkspace, artifact: { id: string; absolutePath: string }, mutate: (value: Record<string, unknown>) => void) {
  const value = JSON.parse(await readFile(artifact.absolutePath, "utf8")) as Record<string, unknown>;
  mutate(value);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(artifact.absolutePath, contents);
  const manifestPath = join(workspace.path, "artifact-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; sha256: string }[] };
  const record = manifest.artifacts.find((candidate) => candidate.id === artifact.id);
  if (!record) throw new Error("Expected registered artifact");
  record.sha256 = sha256Text(contents);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("executeTestInstance", () => {
  it("ingests a safe governed plan, executes its canonical browser entry in Chromium, and registers the workspace-bound result", async () => {
    const { workspace, registeredCase } = await governedWorkspace();

    const attempt = await executeTestInstance({ workspace, browser, attemptId: "ATTEMPT-GOVERNED", testCaseArtifactId: registeredCase.id, resolveSecret: () => "qa@example.test" });
    const artifacts = await workspace.readRegisteredArtifacts();

    expect(attempt).toMatchObject({ runId: workspace.runId, status: "PASSED", testCaseRevisionId: "REV-BROWSER", testCaseInstanceId: "INSTANCE-BROWSER" });
    expect(attempt.telemetry).toContainEqual(expect.objectContaining({ kind: "console", level: "warning", message: "fixture initialized" }));
    expect(artifacts.some((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === "ATTEMPT-GOVERNED" && artifact.value.runId === workspace.runId)).toBe(true);
    expect(JSON.stringify(attempt)).not.toContain("qa@example.test");
  });

  it("rejects self-approved, human-review, revision, instance, and DSL-substitution bindings", async () => {
    await expect(governedWorkspace({ decision: { approved: true, mode: "AUTO_APPROVED", reasons: [] } })).rejects.toThrow(/approval decision|self.*approv|derived/i);
    const humanReview = await governedWorkspace({ policy: "human-review" });
    await expect(executeTestInstance({ workspace: humanReview.workspace, browser, attemptId: "ATTEMPT-HUMAN", testCaseArtifactId: humanReview.registeredCase.id })).rejects.toThrow(/approved|human/i);
    await humanReview.workspace.registerArtifactValue({
      type: "approval-decision",
      relationships: [humanReview.registeredPlan.id],
      provenance: "human-approval:reviewer@example.test",
      value: {
        artifactType: "approval-decision", schemaVersion: "1.0.0", producerVersion: "1.0.0",
        approvalId: "APPROVAL-HUMAN", runId: humanReview.workspace.runId,
        planArtifactId: humanReview.registeredPlan.id, planSha256: humanReview.registeredPlan.sha256,
        decision: "APPROVED", approvedBy: "reviewer@example.test", approvedAt: "2026-07-24T00:00:00.000Z",
      },
    });
    await expect(executeTestInstance({ workspace: humanReview.workspace, browser, attemptId: "ATTEMPT-HUMAN-APPROVED", testCaseArtifactId: humanReview.registeredCase.id, resolveSecret: () => "qa@example.test" })).resolves.toMatchObject({ status: "PASSED" });

    const revision = await governedWorkspace({ revisionId: "REV-PLAN", testCaseRevisionId: "REV-CASE" });
    await expect(executeTestInstance({ workspace: revision.workspace, browser, attemptId: "ATTEMPT-REVISION", testCaseArtifactId: revision.registeredCase.id })).rejects.toThrow(/revision|binding/i);

    const instance = await governedWorkspace({ instanceId: "INSTANCE-PLAN", testCaseInstanceId: "INSTANCE-CASE" });
    await expect(executeTestInstance({ workspace: instance.workspace, browser, attemptId: "ATTEMPT-INSTANCE", testCaseArtifactId: instance.registeredCase.id })).rejects.toThrow(/instance|binding/i);

    const substitution = await governedWorkspace();
    const original = await substitution.workspace.readRegisteredArtifacts();
    const caseArtifact = original.find((artifact) => artifact.record.id === substitution.registeredCase.id);
    expect(caseArtifact?.value.execution).toBeUndefined();
    await expect(substitution.workspace.registerArtifactValue({ type: "test-case", value: { ...testCase(), execution: { browserDsl: browserDsl() } }, relationships: [substitution.registeredPlan.id] })).rejects.toThrow(/contract/i);

    const tamperedDecision = await governedWorkspace();
    await rechecksumArtifact(tamperedDecision.workspace, tamperedDecision.registeredPlan, (value) => { value.approvalDecision = { approved: false, mode: "HUMAN_REVIEW", reasons: ["tampered"] }; });
    await expect(tamperedDecision.workspace.readRegisteredArtifacts()).rejects.toThrow(/approval.*derived|derived.*approval/i);

    const tamperedDsl = await governedWorkspace();
    await rechecksumArtifact(tamperedDsl.workspace, tamperedDsl.registeredPlan, (value) => {
      const first = (value.testCases as { browserExecution: { browserDsl: { steps: { action: { url: string } }[] } } }[])[0];
      if (!first) throw new Error("Expected browser testcase");
      first.browserExecution.browserDsl.steps[0]!.action.url = "https://substituted.example.test";
    });
    await expect(executeTestInstance({ workspace: tamperedDsl.workspace, browser, attemptId: "ATTEMPT-DSL-TAMPER", testCaseArtifactId: tamperedDsl.registeredCase.id })).rejects.toThrow(/approval|invalid|binding/i);
  });

  it("executes external browser actions only through an exact permit and keeps production none-only", async () => {
    const dsl = { steps: [{ id: "external-open", action: { kind: "open", url: baseUrl }, sideEffect: "external" as const }] } satisfies { steps: readonly BrowserTestStep[] };
    const approved = await governedWorkspace({ policy: "human-review", dsl });
    await approved.workspace.registerArtifactValue({
      type: "approval-decision", relationships: [approved.registeredPlan.id], provenance: "human-approval:reviewer",
      value: { artifactType: "approval-decision", schemaVersion: "1.0.0", producerVersion: "1.0.0", approvalId: "APPROVAL-EXTERNAL", runId: approved.workspace.runId, planArtifactId: approved.registeredPlan.id, planSha256: approved.registeredPlan.sha256, decision: "APPROVED", approvedBy: "reviewer", approvedAt: "2026-07-24T00:00:00.000Z" },
    });
    await expect(executeTestInstance({ workspace: approved.workspace, browser, attemptId: "ATTEMPT-NO-PERMIT", testCaseArtifactId: approved.registeredCase.id, environment })).resolves.toMatchObject({ status: "BLOCKED" });
    const permits = new ExternalPermitRegistry([{ permitId: "PERMIT-BROWSER", source: "review-123", channel: "browser", action: "open", environment: "test", target: baseUrl, expiresAt: "2030-01-01T00:00:00.000Z", maxUses: 1 }]);
    await expect(executeTestInstance({ workspace: approved.workspace, browser, attemptId: "ATTEMPT-PERMITTED", testCaseArtifactId: approved.registeredCase.id, environment, externalPermitRegistry: permits })).resolves.toMatchObject({ status: "PASSED" });

    const productionRoot = await mkdtemp(join(tmpdir(), "qa-skills-browser-production-")); roots.push(productionRoot);
    const production = await RunWorkspace.create({ root: productionRoot, mode: "execute", environmentProfile: { ...environment, environmentProfileId: "env-browser-production", classification: "production", productionReadOnly: true } });
    await expect(permits.authorizeAndConsume({ sideEffect: "external", action: "open", channel: "browser", target: baseUrl }, { classification: "production" })).resolves.toMatchObject({ allowed: false });
    await production.close();
  });

  it("pins the fail-open: the external permit-requiring step blocked WITH environment executes with no authorization decision WITHOUT environment", async () => {
    const dsl = { steps: [{ id: "external-open", action: { kind: "open", url: baseUrl }, sideEffect: "external" as const }] } satisfies { steps: readonly BrowserTestStep[] };
    const approved = await governedWorkspace({ policy: "human-review", dsl });
    await approved.workspace.registerArtifactValue({
      type: "approval-decision", relationships: [approved.registeredPlan.id], provenance: "human-approval:reviewer",
      value: { artifactType: "approval-decision", schemaVersion: "1.0.0", producerVersion: "1.0.0", approvalId: "APPROVAL-FAILOPEN", runId: approved.workspace.runId, planArtifactId: approved.registeredPlan.id, planSha256: approved.registeredPlan.sha256, decision: "APPROVED", approvedBy: "reviewer", approvedAt: "2026-07-24T00:00:00.000Z" },
    });

    // Contrast: the identical external `open` step, run WITH `environment` and no permit, is denied by authorization (matches the `:159` `ATTEMPT-NO-PERMIT` pin).
    const withEnvironment = await executeTestInstance({ workspace: approved.workspace, browser, attemptId: "ATTEMPT-FAILOPEN-WITH-ENV", testCaseArtifactId: approved.registeredCase.id, environment });
    expect(withEnvironment.status).toBe("BLOCKED");
    expect(withEnvironment.steps.map((step) => step.status)).toEqual(["BLOCKED"]);

    // CHARACTERIZATION: safety authorization is currently opt-in — omitting `environment` disarms it. A later hardening will make authorization mandatory; this pin must then flip.
    const withoutEnvironment = await executeTestInstance({ workspace: approved.workspace, browser, attemptId: "ATTEMPT-FAILOPEN-NO-ENV", testCaseArtifactId: approved.registeredCase.id });
    expect(withoutEnvironment.status).toBe("PASSED");
    expect(withoutEnvironment.status).not.toBe("BLOCKED");
    expect(withoutEnvironment.steps.every((step) => step.status !== "BLOCKED")).toBe(true);
  });

  it("serializes concurrent calls into distinct fresh contexts, exposes the registry during execution, and recovers after a failure", async () => {
    const { workspace, registeredCase } = await governedWorkspace();
    const contexts: object[] = [];
    const active: boolean[] = [];
    const capture = ({ attemptId, session }: { attemptId: string; session: ActiveBrowserSession }) => {
      active.push(activeBrowserSessions.has(attemptId));
      contexts.push(session.context);
    };
    const first = executeTestInstance({ workspace, browser, attemptId: "ATTEMPT-CONCURRENT-1", testCaseArtifactId: registeredCase.id, resolveSecret: () => "qa@example.test", onSessionActive: capture });
    const second = executeTestInstance({ workspace, browser, attemptId: "ATTEMPT-CONCURRENT-2", testCaseArtifactId: registeredCase.id, resolveSecret: () => "qa@example.test", onSessionActive: capture });
    const [one, two] = await Promise.all([first, second]);
    expect([one.contextId, two.contextId]).not.toEqual([two.contextId, one.contextId]);
    expect(new Set(contexts).size).toBe(2);
    expect(active).toEqual([true, true]);
    expect(activeBrowserSessions.size).toBe(0);

    await expect(executeTestInstance({ workspace, browser, attemptId: "ATTEMPT-DUPLICATE", testCaseArtifactId: "missing" })).rejects.toThrow(/approved|artifact/i);
    await expect(executeTestInstance({ workspace, browser, attemptId: "ATTEMPT-AFTER-FAILURE", testCaseArtifactId: registeredCase.id, resolveSecret: () => "qa@example.test" })).resolves.toMatchObject({ status: "PASSED" });
    await expect(executeTestInstance({ workspace, browser, attemptId: "ATTEMPT-CONCURRENT-1", testCaseArtifactId: registeredCase.id })).rejects.toThrow(/already registered/i);
  });

  it("redacts a resolved secret from failed assertion errors, telemetry, and the registered result", async () => {
    const secret = "secret-NEVER-serialize-9b6f";
    const dsl = { steps: [
      { id: "open", action: { kind: "open", url: baseUrl }, sideEffect: "none" },
      { id: "mismatch", action: { kind: "fill", locator: { label: "Email" }, value: "not-the-secret" }, assertions: [{ kind: "value", locator: { label: "Email" }, value: { secretRef: "mismatch-secret" } }], sideEffect: "none" },
    ] } satisfies { steps: readonly BrowserTestStep[] };
    const { workspace, registeredCase } = await governedWorkspace({ dsl });

    const attempt = await executeTestInstance({
      workspace, browser, attemptId: "ATTEMPT-REDACTION", testCaseArtifactId: registeredCase.id,
      resolveSecret: () => secret,
      onSessionActive: async ({ session }) => { await session.page.evaluate((value) => console.error(`telemetry:${value}`), secret); },
    });
    const artifacts = await workspace.readRegisteredArtifacts();
    const serialized = JSON.stringify({ attempt, artifacts });

    expect(attempt.status).toBe("FAILED");
    expect(attempt.steps[1]?.error).toContain("[REDACTED]");
    expect(attempt.telemetry.some((finding) => finding.message.includes("[REDACTED]"))).toBe(true);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("NEVER-serialize");
  });

  it("classifies only an assertion bound to an approved authoritative expected result as a product defect and leaves every other failure undetermined", async () => {
    const authoritativeDsl = { steps: [
      { id: "open", action: { kind: "open", url: baseUrl }, sideEffect: "none" },
      { id: "mismatch", action: { kind: "wait", milliseconds: 0 }, assertions: [{ kind: "text", locator: { testId: "result" }, text: "Missing", expectedResultId: "ER-BROWSER" }], sideEffect: "none" },
    ] } satisfies { steps: readonly BrowserTestStep[] };
    const authoritative = await governedWorkspace({ dsl: authoritativeDsl });
    await executeTestInstance({ workspace: authoritative.workspace, browser, attemptId: "ATTEMPT-AUTHORITY", testCaseArtifactId: authoritative.registeredCase.id });
    const authoritativeResult = (await authoritative.workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === "ATTEMPT-AUTHORITY");
    expect(authoritativeResult?.value.failureClassification).toBe("PRODUCT_DEFECT");

    const unboundDsl = { steps: [
      { id: "open", action: { kind: "open", url: baseUrl }, sideEffect: "none" },
      { id: "mismatch", action: { kind: "wait", milliseconds: 0 }, assertions: [{ kind: "text", locator: { testId: "result" }, text: "Missing" }], sideEffect: "none" },
    ] } satisfies { steps: readonly BrowserTestStep[] };
    const unbound = await governedWorkspace({ dsl: unboundDsl });
    await executeTestInstance({ workspace: unbound.workspace, browser, attemptId: "ATTEMPT-UNBOUND", testCaseArtifactId: unbound.registeredCase.id });
    const unboundResult = (await unbound.workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === "ATTEMPT-UNBOUND");
    expect(unboundResult?.value.failureClassification).toBe("UNDETERMINED");

    await expect(governedWorkspace({ dsl: authoritativeDsl, expectedAuthority: "INFERRED" })).rejects.toThrow(/approved|authoritative|auto-approval/i);
  });

  it("runs one real Chromium attempt through fail-fast dependent and independent steps without retrying", async () => {
    const dsl = { steps: [
      { id: "open", action: { kind: "open", url: baseUrl }, sideEffect: "none" },
      { id: "fail", action: { kind: "wait", milliseconds: 0 }, assertions: [{ kind: "count", locator: { role: "button" }, count: 2 }], sideEffect: "none" },
      { id: "dependent", action: { kind: "fill", locator: { label: "Email" }, value: "not-run" }, sideEffect: "none" },
      { id: "independent", action: { kind: "wait", milliseconds: 0 }, sideEffect: "none", independent: true },
    ] } satisfies { steps: readonly BrowserTestStep[] };
    const { workspace, registeredCase } = await governedWorkspace({ dsl });
    let createdContexts = 0;
    const countedBrowser = { newContext: (...args: Parameters<Browser["newContext"]>) => {
      createdContexts += 1;
      return browser.newContext(...args);
    } } as Browser;

    const attempt = await executeTestInstance({ workspace, browser: countedBrowser, attemptId: "ATTEMPT-FAIL-FAST", testCaseArtifactId: registeredCase.id });

    expect(attempt.status).toBe("FAILED");
    expect(attempt.steps.map((step) => step.status)).toEqual(["PASSED", "FAILED", "NOT_RUN", "PASSED"]);
    expect(createdContexts).toBe(1);
  });

  it("keeps the runtime-owned session alive until the completed attempt is available to the close hook", async () => {
    const { workspace, registeredCase } = await governedWorkspace();
    let observed: { status: string; resultPresent: boolean; saved: string | null } | undefined;

    await executeTestInstance({
      workspace, browser, attemptId: "ATTEMPT-CLOSE-HOOK", testCaseArtifactId: registeredCase.id, resolveSecret: () => "qa@example.test",
      onBeforeSessionClose: async ({ attempt, session }) => {
        observed = {
          status: attempt.status,
          resultPresent: activeBrowserSessions.get(attempt.attemptId) === session,
          saved: await session.page.getByTestId("result").textContent(),
        };
      },
    });

    expect(observed).toEqual({ status: "PASSED", resultPresent: true, saved: "Saved" });
    expect(activeBrowserSessions.has("ATTEMPT-CLOSE-HOOK")).toBe(false);
  });

  it("rejects a duplicate queued attempt before it can overwrite the live registry entry", async () => {
    const { workspace, registeredCase } = await governedWorkspace();
    let release: (() => void) | undefined;
    const active = new Promise<void>((resolve) => { release = resolve; });
    const first = executeTestInstance({
      workspace, browser, attemptId: "ATTEMPT-LIVE-DUPLICATE", testCaseArtifactId: registeredCase.id, resolveSecret: () => "qa@example.test",
      onSessionActive: async ({ attemptId, session }) => {
        expect(activeBrowserSessions.get(attemptId)).toBe(session);
        await active;
      },
    });
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!activeBrowserSessions.has("ATTEMPT-LIVE-DUPLICATE")) return;
        clearInterval(timer);
        resolve();
      }, 1);
    });

    await expect(executeTestInstance({ workspace, browser, attemptId: "ATTEMPT-LIVE-DUPLICATE", testCaseArtifactId: registeredCase.id })).rejects.toThrow(/already active or queued/i);
    expect(activeBrowserSessions.get("ATTEMPT-LIVE-DUPLICATE")?.page).toBeTruthy();
    release?.();
    await expect(first).resolves.toMatchObject({ status: "PASSED" });
  });
});
