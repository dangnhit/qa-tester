import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "@playwright/test";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { captureEvidence, attachEvidence } from "../../src/evidence/collector.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { activeBrowserSessions } from "../../src/browser/session-registry.js";

function pixel(bytes: Buffer, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4;
  return [...bytes.subarray(offset, offset + 4)];
}

async function registerAttempt(workspace: RunWorkspace, attemptId: string): Promise<void> {
  const testCase = await workspace.registerArtifactValue({ type: "test-case", value: {
    artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "test", testCaseId: `TC-${attemptId}`, revisionId: "REV-1", instanceId: "INSTANCE-1", title: "Evidence fixture", steps: [{ id: "step-1", action: "observe", sideEffect: "none" }],
    coverage: { requirementId: "REQ-1", role: "tester", behavior: "capture", browser: "chromium", viewport: { width: 80, height: 60 }, accessibilityMethod: null, risk: "low", outcome: "capture completes" },
  }, relationships: [], provenance: "test" });
  await workspace.registerArtifactValue({ type: "test-result", value: {
    artifactType: "test-result", schemaVersion: "2.0.0", producerVersion: "test", attemptId, runId: workspace.runId, testCaseId: `TC-${attemptId}`, testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1", status: "PASSED", failureClassification: "NONE", observedEngine: "chromium", steps: [{ stepId: "step-1", status: "PASSED", durationMs: 1 }], startedAt: "2026-07-23T12:00:00.000Z", finishedAt: "2026-07-23T12:00:01.000Z",
  }, relationships: [testCase.id], provenance: "test" });
}

describe("live evidence collector", () => {
  it("masks protected DOM and region pixels while preserving known unmasked screenshot pixels", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-evidence-workspace-"));
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "env-evidence", name: "Evidence", classification: "test", baseUrl: "https://example.test", productionReadOnly: false } });
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 80, height: 60 } });
    const page = await context.newPage();
    const attemptId = "attempt-live";
    await registerAttempt(workspace, attemptId);
    activeBrowserSessions.set(attemptId, { context, page, telemetry: { findings: [], responseStatuses: new Map(), networkRecords: [] }, secrets: new Set() });
    try {
      await page.setContent('<style>html,body{margin:0;background:#123456}.secret,#region{position:fixed;width:16px;height:16px}.secret{left:10px;top:10px;background:#ef4444}#region{left:45px;top:10px;background:#3b82f6}</style><div class="secret">secret</div><div id="region">region</div>');
      const before = await page.screenshot({ type: "png" });
      const result = await captureEvidence({ workspace, attemptId, callerAttemptId: attemptId, protectedEnvironment: true, redaction: { domSelectors: [".secret"], regions: [{ x: 45, y: 10, width: 16, height: 16 }] } });
      expect(result.kind).toBe("evidence");
      if (result.kind === "evidence") {
        expect((await readFile(result.rawPath)).length).toBeGreaterThan(0);
        expect(result.rawPath.startsWith(workspace.path)).toBe(true);
        const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as { artifacts: { id: string; relativePath: string; mediaType?: string }[] };
        expect(manifest.artifacts).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: result.binaryArtifactId, relativePath: expect.stringMatching(/^evidence\//), mediaType: "image/png" }),
          expect.objectContaining({ id: result.descriptorArtifactId, relativePath: expect.stringMatching(/^inputs\//) }),
        ]));
        const descriptor = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.id === result.descriptorArtifactId);
        const attempt = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === attemptId);
        expect(descriptor?.record.relationships).toContain(attempt?.record.id);
        expect(descriptor?.value).toMatchObject({ subject: { kind: "attempt", attemptId, testCaseId: `TC-${attemptId}`, testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" } });
        const [beforePixels, capturedPixels] = await Promise.all([
          sharp(before).ensureAlpha().raw().toBuffer(),
          sharp(await readFile(result.rawPath)).ensureAlpha().raw().toBuffer(),
        ]);
        expect(pixel(capturedPixels, 80, 12, 12)).not.toEqual(pixel(beforePixels, 80, 12, 12));
        expect(pixel(capturedPixels, 80, 47, 12)).not.toEqual(pixel(beforePixels, 80, 47, 12));
        expect(pixel(capturedPixels, 80, 2, 2)).toEqual(pixel(beforePixels, 80, 2, 2));
      }
    } finally {
      activeBrowserSessions.delete(attemptId);
      await context.close();
      await browser.close();
      await workspace.close();
    }
  });

  it("records an Evidence Gap instead of reconstructing telemetry from a closed session", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-evidence-closed-"));
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "env-closed", name: "Closed", classification: "test", baseUrl: "https://example.test", productionReadOnly: false } });
    const gap = await attachEvidence({ workspace, attemptId: "closed", callerAttemptId: "closed", telemetry: "console" });
    expect(gap).toMatchObject({ kind: "evidence-gap", gap: expect.objectContaining({ reason: expect.stringMatching(/active.*session/i) }) });
    await workspace.close();
  });

  it("creates a registered Evidence Gap without writing a protected screenshot when a required selector matches nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-evidence-gap-"));
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "env-gap", name: "Gap", classification: "test", baseUrl: "https://example.test", productionReadOnly: false } });
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    activeBrowserSessions.set("attempt-gap", { context, page, telemetry: { findings: [], responseStatuses: new Map(), networkRecords: [] }, secrets: new Set() });
    try {
      const result = await captureEvidence({ workspace, attemptId: "attempt-gap", callerAttemptId: "attempt-gap", protectedEnvironment: true, redaction: { domSelectors: [".does-not-exist"], regions: [] } });
      expect(result).toMatchObject({ kind: "evidence-gap", gap: expect.objectContaining({ affectedClaim: "screenshot capture" }) });
      const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as { artifacts: { type: string }[] };
      expect(manifest.artifacts.filter((artifact) => artifact.type === "evidence")).toHaveLength(0);
      expect(manifest.artifacts.filter((artifact) => artifact.type === "evidence-gap")).toHaveLength(1);
      const gap = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "evidence-gap");
      expect(gap?.value).toMatchObject({ scope: "operational" });
      expect(gap?.value).not.toHaveProperty("attemptId");
    } finally {
      activeBrowserSessions.delete("attempt-gap");
      await context.close();
      await browser.close();
      await workspace.close();
    }
  });

  it("registers a screenshot Evidence Gap for a non-protected active session containing a resolved visible secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-evidence-visible-secret-"));
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "env-visible-secret", name: "Visible secret", classification: "test", baseUrl: "https://example.test", productionReadOnly: false } });
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    const attemptId = "attempt-visible-secret";
    const secret = "visible-secret-never-in-pixels";
    await registerAttempt(workspace, attemptId);
    await page.setContent(`<label>Email <input value="${secret}"></label>`);
    activeBrowserSessions.set(attemptId, { context, page, secrets: new Set([secret]), telemetry: { findings: [], responseStatuses: new Map(), networkRecords: [] } });
    try {
      const result = await captureEvidence({ workspace, attemptId, callerAttemptId: attemptId, protectedEnvironment: false, redaction: { domSelectors: [], regions: [] } });
      expect(result).toMatchObject({ kind: "evidence-gap", gap: expect.objectContaining({ affectedClaim: "screenshot capture", reason: expect.stringMatching(/secret/i) }) });
      const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as { artifacts: { type: string }[] };
      expect(manifest.artifacts.filter((artifact) => artifact.type === "evidence")).toHaveLength(0);
      expect(manifest.artifacts.filter((artifact) => artifact.type === "evidence-gap")).toHaveLength(1);
      expect(JSON.stringify(await workspace.readRegisteredArtifacts())).not.toContain(secret);
    } finally {
      activeBrowserSessions.delete(attemptId);
      await context.close();
      await browser.close();
      await workspace.close();
    }
  });
  it("automatically scrubs active-session secrets from persisted console and network evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-evidence-secrets-"));
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "env-secret", name: "Secret", classification: "test", baseUrl: "https://example.test", productionReadOnly: false } });
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    const secret = "distinctive-secret-value";
    await registerAttempt(workspace, "attempt-secret");
    activeBrowserSessions.set("attempt-secret", { context, page, secrets: new Set([secret]), telemetry: { findings: [{ kind: "console", message: `console ${secret}`, url: `https://example.test/?token=${secret}`, timestamp: new Date().toISOString() }], responseStatuses: new Map(), networkRecords: [{ url: `https://example.test/?token=${secret}`, requestHeaders: { Authorization: `Bearer ${secret}` }, requestBody: `password=${secret}` }] } });
    try {
      const result = await attachEvidence({ workspace, attemptId: "attempt-secret", callerAttemptId: "attempt-secret", telemetry: "network" });
      expect(result.kind).toBe("evidence");
      if (result.kind === "evidence") {
        const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as { artifacts: { id: string; relativePath: string }[] };
        const binary = manifest.artifacts.find((artifact) => artifact.id === result.binaryArtifactId);
        if (!binary) throw new Error("Expected network evidence binary");
        expect(await readFile(join(workspace.path, binary.relativePath), "utf8")).not.toContain(secret);
        expect(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")).not.toContain(secret);
      }
    } finally {
      activeBrowserSessions.delete("attempt-secret");
      await context.close();
      await browser.close();
      await workspace.close();
    }
  });

  // Before evidence 2.0.0 this path wrote dpr:1, scroll 0,0, a 1x1 clip and 1x1 dimensions/viewport into
  // a checksummed audit artifact. Telemetry measures none of those, so the honest record omits them.
  it("persists no fabricated geometry on a telemetry capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-evidence-no-geometry-"));
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "env-geometry", name: "Geometry", classification: "test", baseUrl: "https://example.test", productionReadOnly: false } });
    const browser = await chromium.launch(); const context = await browser.newContext(); const page = await context.newPage();
    const attemptId = "attempt-no-geometry";
    await registerAttempt(workspace, attemptId);
    activeBrowserSessions.set(attemptId, { context, page, secrets: new Set(), telemetry: { findings: [{ kind: "console", level: "error", message: "boom", timestamp: new Date().toISOString() }], responseStatuses: new Map(), networkRecords: [] } });
    try {
      const result = await attachEvidence({ workspace, attemptId, callerAttemptId: attemptId, telemetry: "console" });
      expect(result.kind).toBe("evidence");
      if (result.kind !== "evidence") return;
      const descriptor = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.id === result.descriptorArtifactId);
      expect(descriptor?.value.schemaVersion).toBe("2.0.0");
      const provenance = descriptor?.value.provenance as Record<string, unknown>;
      expect(provenance.captureType).toBe("console");
      for (const field of ["dimensions", "dpr", "scroll", "clip", "viewport"]) expect(provenance).not.toHaveProperty(field);
    } finally { activeBrowserSessions.delete(attemptId); await context.close(); await browser.close(); await workspace.close(); }
  });

  it("never persists arbitrary protected telemetry PII without a registered deterministic scrubber", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-evidence-protected-telemetry-"));
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "env-protected", name: "Protected", classification: "production", baseUrl: "https://example.test", productionReadOnly: true } });
    const browser = await chromium.launch(); const context = await browser.newContext(); const page = await context.newPage();
    const attemptId = "attempt-protected-pii"; const pii = "customer+private@personal.example";
    await registerAttempt(workspace, attemptId);
    activeBrowserSessions.set(attemptId, { context, page, secrets: new Set(), telemetry: { findings: [{ kind: "console", level: "error", message: `leaked ${pii}`, timestamp: new Date().toISOString() }], responseStatuses: new Map(), networkRecords: [{ url: `https://example.test/account/${pii}`, requestBody: `email=${pii}`, responseBody: pii }] } });
    try {
      await expect(attachEvidence({ workspace, attemptId, callerAttemptId: attemptId, telemetry: "network", protectedEnvironment: true })).resolves.toMatchObject({ kind: "evidence-gap" });
      const manifest = await readFile(join(workspace.path, "artifact-manifest.json"), "utf8");
      expect(manifest).not.toContain(pii);
      expect(JSON.stringify(await workspace.readRegisteredArtifacts())).not.toContain(pii);
    } finally { activeBrowserSessions.delete(attemptId); await context.close(); await browser.close(); await workspace.close(); }
  });

  it("executes a concrete protected-telemetry scrubber before persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-evidence-protected-scrubber-"));
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "env-protected-scrubber", name: "Protected", classification: "production", baseUrl: "https://example.test", productionReadOnly: true } });
    const browser = await chromium.launch(); const context = await browser.newContext(); const page = await context.newPage();
    const attemptId = "attempt-protected-scrubber"; const pii = "customer+private@personal.example";
    await registerAttempt(workspace, attemptId);
    activeBrowserSessions.set(attemptId, { context, page, secrets: new Set(), telemetry: { findings: [{ kind: "network", level: "error", message: `leaked ${pii}`, timestamp: new Date().toISOString() }], responseStatuses: new Map(), networkRecords: [{ url: `https://example.test/account/${pii}`, requestBody: `email=${pii}`, responseBody: pii }] } });
    let invocations = 0;
    try {
      const result = await attachEvidence({
        workspace,
        attemptId,
        callerAttemptId: attemptId,
        telemetry: "network",
        protectedEnvironment: true,
        telemetryScrubber: (payload, context) => {
          invocations += 1;
          expect(context).toEqual({ attemptId, channel: "network" });
          return JSON.parse(JSON.stringify(payload).replaceAll(pii, "[PII]")) as typeof payload;
        },
      });
      expect(result.kind).toBe("evidence");
      expect(invocations).toBe(1);
      const persisted = await Promise.all((await workspace.readRegisteredArtifacts()).filter((artifact) => artifact.record.type === "evidence").map((artifact) => readFile(join(workspace.path, artifact.record.relativePath), "utf8")));
      expect(persisted.join("\n")).not.toContain(pii);
    } finally { activeBrowserSessions.delete(attemptId); await context.close(); await browser.close(); await workspace.close(); }
  });
});
