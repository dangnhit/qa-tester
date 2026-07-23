import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { attachTelemetry } from "../browser/playwright/telemetry.js";
import sharp from "sharp";
import type { ActiveBrowserSession, TelemetryFinding } from "../browser/types.js";
import { createEntityId } from "../core/ids.js";
import { atomicWriteFile, assertPathWithin } from "../core/fs.js";
import { activeBrowserSessions } from "../operations/execute-browser-test.js";
import { evidenceFilename, createEvidenceManifest, type EvidenceManifest, type EvidenceProvenance } from "./manifest.js";
import { redactText, validateRedactionPlan, type CssBox, type EvidenceGap, type RedactionPlan } from "./redaction.js";

type GapResult = { kind: "evidence-gap"; gap: EvidenceGap };
export type CapturedEvidence = { kind: "evidence"; evidenceId: string; rawPath: string; manifest: EvidenceManifest };
export type EvidenceCaptureResult = CapturedEvidence | GapResult;
export type EvidenceAttachment = { kind: "evidence"; telemetry: readonly TelemetryFinding[] } | GapResult;
type PageRuntime = {
  document: {
    createElement(tag: string): { id: string; setAttribute(name: string, value: string): void; style: Record<string, string>; dataset: Record<string, string> };
    documentElement: { appendChild(node: unknown): void };
    getElementById(id: string): { remove(): void } | null;
  };
  scrollX: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
  location: { href: string };
};

function evidenceGap(runId: string, reason: string, affectedClaim: string): GapResult {
  return { kind: "evidence-gap", gap: { artifactType: "evidence-gap", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId, reason, affectedClaim } };
}

function activeSession(attemptId: string, callerAttemptId: string): ActiveBrowserSession | undefined {
  if (attemptId !== callerAttemptId) return undefined;
  return activeBrowserSessions.get(attemptId);
}

async function applyRegionMasks(session: ActiveBrowserSession, regions: readonly CssBox[]): Promise<string[]> {
  if (regions.length === 0) return [];
  return session.page.evaluate((boxes) => boxes.map((box, index) => {
    const browser = globalThis as unknown as PageRuntime;
    const node = browser.document.createElement("div");
    const id = `qa-evidence-mask-${crypto.randomUUID()}`;
    node.id = id;
    node.setAttribute("aria-hidden", "true");
    Object.assign(node.style, {
      position: "fixed", left: `${box.x - browser.scrollX}px`, top: `${box.y - browser.scrollY}px`, width: `${box.width}px`, height: `${box.height}px`,
      background: "#000", zIndex: "2147483647", pointerEvents: "none", display: "block", opacity: "1",
    });
    node.dataset.index = String(index);
    browser.document.documentElement.appendChild(node);
    return id;
  }), regions);
}

async function removeRegionMasks(session: ActiveBrowserSession, ids: readonly string[]): Promise<void> {
  await session.page.evaluate((maskIds) => {
    const browser = globalThis as unknown as PageRuntime;
    for (const id of maskIds) browser.document.getElementById(id)?.remove();
  }, [...ids]);
}

/** Registers telemetry before actions for direct collector users. Task 4 sessions already do this at creation time. */
export function beginEvidenceCapture(session: ActiveBrowserSession): void {
  if (session.telemetry.findings.length === 0 && session.telemetry.responseStatuses.size === 0) attachTelemetry(session.page);
}

/** Captures a masked screenshot into a sanitized raw file; a failure to mask produces an Evidence Gap. */
export async function captureEvidence(input: { attemptId: string; callerAttemptId: string; runId: string; outputDirectory: string; workspaceRoot?: string; protectedEnvironment: boolean; redaction: Pick<RedactionPlan, "domSelectors" | "regions">; build?: string }): Promise<EvidenceCaptureResult> {
  const session = activeSession(input.attemptId, input.callerAttemptId);
  if (session === undefined) return evidenceGap(input.runId, "No active caller-owned browser evidence session is available", "screenshot capture");
  const plan: RedactionPlan = { protectedEnvironment: input.protectedEnvironment, domSelectors: input.redaction.domSelectors, regions: input.redaction.regions };
  const planCheck = validateRedactionPlan(plan);
  if (!planCheck.safe) return evidenceGap(input.runId, planCheck.gap.reason, planCheck.gap.affectedClaim);
  try {
    if (input.workspaceRoot !== undefined) await assertPathWithin(input.workspaceRoot, input.outputDirectory);
    await mkdir(input.outputDirectory, { recursive: true });
    if (input.workspaceRoot !== undefined) await assertPathWithin(input.workspaceRoot, input.outputDirectory);
    const selectors = input.protectedEnvironment ? input.redaction.domSelectors : [];
    const mask = selectors.map((selector) => session.page.locator(selector));
    // Count first: an invalid selector must fail before a byte reaches disk.
    for (const locator of mask) await locator.count();
    const ids = input.protectedEnvironment ? await applyRegionMasks(session, input.redaction.regions) : [];
    const evidenceId = createEntityId();
    const rawPath = join(resolve(input.outputDirectory), evidenceFilename(evidenceId, "sanitized-raw"));
    if (input.workspaceRoot !== undefined) await assertPathWithin(input.workspaceRoot, rawPath);
    try {
      const bytes = await session.page.screenshot({ type: "png", ...(mask.length === 0 ? {} : { mask }) });
      await atomicWriteFile(input.workspaceRoot ?? input.outputDirectory, rawPath, bytes);
      const [metadata, pageMetrics] = await Promise.all([
        sharp(bytes).metadata(),
        session.page.evaluate(() => {
          const browser = globalThis as unknown as PageRuntime;
          return { scroll: { x: browser.scrollX, y: browser.scrollY }, url: browser.location.href, viewport: { width: browser.innerWidth, height: browser.innerHeight } };
        }),
      ]);
      if (metadata.width === undefined || metadata.height === undefined || pageMetrics.viewport.width <= 0 || pageMetrics.viewport.height <= 0) throw new Error("Screenshot dimensions are unavailable");
      const provenance: EvidenceProvenance = {
        evidenceId, runId: input.runId, attemptId: input.attemptId, captureType: "screenshot",
        dpr: metadata.width / pageMetrics.viewport.width, scroll: pageMetrics.scroll,
        clip: { x: 0, y: 0, width: pageMetrics.viewport.width, height: pageMetrics.viewport.height },
        url: pageMetrics.url, viewport: pageMetrics.viewport, browser: "playwright", build: input.build ?? "unknown", capturedAt: new Date().toISOString(), dimensions: { width: metadata.width, height: metadata.height },
      };
      const manifest = await createEvidenceManifest({ ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }), rawPath, provenance });
      return { kind: "evidence", evidenceId, rawPath, manifest };
    } finally {
      await removeRegionMasks(session, ids);
    }
  } catch (error) {
    return evidenceGap(input.runId, `Capture-time redaction could not be completed safely: ${error instanceof Error ? error.message : String(error)}`, "screenshot capture");
  }
}

/** Returns only scrubbed telemetry from an active session; it never reconstructs closed-session observations. */
export function attachEvidence(input: { attemptId: string; callerAttemptId: string; runId: string; telemetry: "console" | "network" | "log"; secrets?: readonly string[] }): EvidenceAttachment {
  const session = activeSession(input.attemptId, input.callerAttemptId);
  if (session === undefined) return evidenceGap(input.runId, "An active caller-owned browser evidence session is required; closed-session telemetry cannot be reconstructed", `${input.telemetry} telemetry`);
  const secrets = input.secrets ?? [];
  const telemetry = session.telemetry.findings.filter((finding) => input.telemetry === "log" || finding.kind === input.telemetry).map((finding) => ({ ...finding, message: redactText(finding.message, secrets), ...(finding.url === undefined ? {} : { url: redactText(finding.url, secrets) }) }));
  return { kind: "evidence", telemetry };
}
