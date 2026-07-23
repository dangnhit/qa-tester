import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { captureEvidence, attachEvidence } from "../../src/evidence/collector.js";
import { activeBrowserSessions } from "../../src/operations/execute-browser-test.js";

describe("live evidence collector", () => {
  it("captures sanitized live screenshots only from an active caller-owned attempt", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 80, height: 60 } });
    const page = await context.newPage();
    const attemptId = "attempt-live";
    activeBrowserSessions.set(attemptId, { context, page, telemetry: { findings: [], responseStatuses: new Map() } });
    try {
      await page.setContent('<input class="secret" value="secret-value"><p>visible</p>');
      const result = await captureEvidence({ attemptId, callerAttemptId: attemptId, outputDirectory: await mkdtemp(join(tmpdir(), "qa-capture-")), runId: "run-1", protectedEnvironment: true, redaction: { domSelectors: [".secret"], regions: [] } });
      expect(result.kind).toBe("evidence");
      if (result.kind === "evidence") expect((await readFile(result.rawPath)).length).toBeGreaterThan(0);
    } finally {
      activeBrowserSessions.delete(attemptId);
      await context.close();
      await browser.close();
    }
  });

  it("records an Evidence Gap instead of reconstructing telemetry from a closed session", () => {
    const gap = attachEvidence({ attemptId: "closed", callerAttemptId: "closed", runId: "run-1", telemetry: "console" });
    expect(gap).toEqual({ kind: "evidence-gap", gap: expect.objectContaining({ reason: expect.stringMatching(/active.*session/i) }) });
  });
});
