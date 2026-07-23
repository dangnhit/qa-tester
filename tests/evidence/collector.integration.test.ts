import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { captureEvidence, attachEvidence } from "../../src/evidence/collector.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { activeBrowserSessions } from "../../src/operations/execute-browser-test.js";

describe("live evidence collector", () => {
  it("registers sanitized raw evidence and its canonical descriptor in the authoritative workspace manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-evidence-workspace-"));
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "env-evidence", name: "Evidence", classification: "test", baseUrl: "https://example.test", productionReadOnly: false } });
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 80, height: 60 } });
    const page = await context.newPage();
    const attemptId = "attempt-live";
    activeBrowserSessions.set(attemptId, { context, page, telemetry: { findings: [], responseStatuses: new Map(), networkRecords: [] }, secrets: new Set() });
    try {
      await page.setContent('<input class="secret" value="secret-value"><p>visible</p>');
      const result = await captureEvidence({ workspace, attemptId, callerAttemptId: attemptId, protectedEnvironment: true, redaction: { domSelectors: [".secret"], regions: [] } });
      expect(result.kind).toBe("evidence");
      if (result.kind === "evidence") {
        expect((await readFile(result.rawPath)).length).toBeGreaterThan(0);
        expect(result.rawPath.startsWith(workspace.path)).toBe(true);
        const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as { artifacts: { id: string; relativePath: string; mediaType?: string }[] };
        expect(manifest.artifacts).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: result.binaryArtifactId, relativePath: expect.stringMatching(/^evidence\//), mediaType: "image/png" }),
          expect.objectContaining({ id: result.descriptorArtifactId, relativePath: expect.stringMatching(/^inputs\//) }),
        ]));
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
    } finally {
      activeBrowserSessions.delete("attempt-gap");
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
});
