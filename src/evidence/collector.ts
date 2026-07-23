import sharp from "sharp";

import type { ActiveBrowserSession, TelemetryFinding } from "../browser/types.js";
import type { RunWorkspace } from "../core/run-workspace.js";
import { createEntityId } from "../core/ids.js";
import { activeBrowserSessions } from "../operations/execute-browser-test.js";
import { evidenceFilename, type EvidenceProvenance } from "./manifest.js";
import { redactNetworkRecord, redactText, validateRedactionPlan, type CssBox, type EvidenceGap, type RedactionPlan } from "./redaction.js";

type GapResult = { kind: "evidence-gap"; gap: EvidenceGap; descriptorArtifactId: string };
export type CapturedEvidence = { kind: "evidence"; evidenceId: string; rawPath: string; binaryArtifactId: string; descriptorArtifactId: string };
export type EvidenceCaptureResult = CapturedEvidence | GapResult;
export type EvidenceAttachment = { kind: "evidence"; evidenceId: string; binaryArtifactId: string; descriptorArtifactId: string; telemetry: readonly TelemetryFinding[] } | GapResult;
type PageRuntime = { document: { createElement(tag: string): { id: string; setAttribute(name: string, value: string): void; style: Record<string, string> }; documentElement: { appendChild(node: unknown): void }; getElementById(id: string): { remove(): void } | null }; scrollX: number; scrollY: number; innerWidth: number; innerHeight: number; location: { href: string } };

function activeSession(attemptId: string, callerAttemptId: string): ActiveBrowserSession | undefined {
  return attemptId === callerAttemptId ? activeBrowserSessions.get(attemptId) : undefined;
}

async function registerGap(workspace: RunWorkspace, attemptId: string, reason: string, affectedClaim: string): Promise<GapResult> {
  const gap = { artifactType: "evidence-gap" as const, schemaVersion: "1.0.0" as const, producerVersion: "0.1.0", evidenceGapId: createEntityId(), runId: workspace.runId, attemptId, reason, affectedClaim };
  const record = await workspace.registerArtifactValue({ type: "evidence-gap", value: gap, relationships: [], provenance: "runtime" });
  return { kind: "evidence-gap", descriptorArtifactId: record.id, gap };
}

async function applyRegionMasks(session: ActiveBrowserSession, regions: readonly CssBox[]): Promise<string[]> {
  return session.page.evaluate((boxes) => boxes.map((box, index) => {
    const browser = globalThis as unknown as PageRuntime;
    const node = browser.document.createElement("div");
    const id = `qa-evidence-mask-${Date.now().toString(36)}-${index}`;
    node.id = id;
    node.setAttribute("aria-hidden", "true");
    Object.assign(node.style, { position: "fixed", left: `${box.x - browser.scrollX}px`, top: `${box.y - browser.scrollY}px`, width: `${box.width}px`, height: `${box.height}px`, background: "#000", zIndex: "2147483647", pointerEvents: "none", display: "block", opacity: "1" });
    browser.document.documentElement.appendChild(node);
    return id;
  }), regions);
}

async function removeRegionMasks(session: ActiveBrowserSession, ids: readonly string[]): Promise<void> {
  await session.page.evaluate((maskIds) => { const browser = globalThis as unknown as PageRuntime; for (const id of maskIds) browser.document.getElementById(id)?.remove(); }, [...ids]);
}

function descriptor(input: { evidenceId: string; workspace: RunWorkspace; attemptId: string; binary: { id: string; relativePath: string; sha256: string; mediaType?: string }; provenance: EvidenceProvenance; telemetryFindings?: readonly TelemetryFinding[] }) {
  const dimensions = input.provenance.dimensions;
  if (!dimensions || !input.binary.mediaType) throw new Error("Evidence dimensions and media type are required");
  return {
    artifactType: "evidence", schemaVersion: "1.0.0", producerVersion: "0.1.0", evidenceId: input.evidenceId, runId: input.workspace.runId, attemptId: input.attemptId,
    kind: input.provenance.captureType, capturedAt: input.provenance.capturedAt, sha256: input.binary.sha256, relativePath: input.binary.relativePath, mediaType: input.binary.mediaType, binaryArtifactIds: [input.binary.id], binaryArtifacts: [{ id: input.binary.id, relativePath: input.binary.relativePath, sha256: input.binary.sha256, mediaType: input.binary.mediaType }],
    ...(input.telemetryFindings === undefined ? {} : { telemetryFindings: input.telemetryFindings.map((finding) => ({ kind: finding.kind, level: finding.level, message: finding.message })) }),
    provenance: { captureType: input.provenance.captureType, dimensions, dpr: input.provenance.dpr, scroll: input.provenance.scroll, clip: input.provenance.clip, ...(input.provenance.cssBoxes === undefined ? {} : { cssBoxes: input.provenance.cssBoxes }), ...(input.provenance.normalizedPixelBoxes === undefined ? {} : { pixelBoxes: input.provenance.normalizedPixelBoxes.map(({ x, y, width, height }) => ({ x, y, width, height })) }), url: input.provenance.url, viewport: input.provenance.viewport, browser: input.provenance.browser, build: input.provenance.build, capturedAt: input.provenance.capturedAt, ...(input.provenance.testcaseId === undefined ? {} : { testcaseId: input.provenance.testcaseId }), ...(input.provenance.bugId === undefined ? {} : { bugId: input.provenance.bugId }) },
  };
}

/** Captures a screenshot only into the supplied run workspace; protected failures produce registered Evidence Gaps before pixels persist. */
export async function captureEvidence(input: { workspace: RunWorkspace; attemptId: string; callerAttemptId: string; protectedEnvironment: boolean; redaction: Pick<RedactionPlan, "domSelectors" | "regions">; build?: string; testcaseId?: string; bugId?: string }): Promise<EvidenceCaptureResult> {
  const session = activeSession(input.attemptId, input.callerAttemptId);
  if (!session) return registerGap(input.workspace, input.attemptId, "No active caller-owned browser evidence session is available", "screenshot capture");
  const plan = validateRedactionPlan({ protectedEnvironment: input.protectedEnvironment, domSelectors: input.redaction.domSelectors, regions: input.redaction.regions });
  if (!plan.safe) return registerGap(input.workspace, input.attemptId, plan.gap.reason, plan.gap.affectedClaim);
  try {
    const masks = input.protectedEnvironment ? input.redaction.domSelectors.map((selector) => session.page.locator(selector)) : [];
    for (const mask of masks) if (await mask.count() === 0) return registerGap(input.workspace, input.attemptId, "Configured redaction selector did not match an element", "screenshot capture");
    const regionIds = input.protectedEnvironment ? await applyRegionMasks(session, input.redaction.regions) : [];
    try {
      const bytes = await session.page.screenshot({ type: "png", ...(masks.length === 0 ? {} : { mask: masks }) });
      const [metadata, metrics] = await Promise.all([sharp(bytes).metadata(), session.page.evaluate(() => { const browser = globalThis as unknown as PageRuntime; return { scroll: { x: browser.scrollX, y: browser.scrollY }, url: browser.location.href, viewport: { width: browser.innerWidth, height: browser.innerHeight } }; })]);
      if (!metadata.width || !metadata.height || metrics.viewport.width <= 0 || metrics.viewport.height <= 0) return registerGap(input.workspace, input.attemptId, "Screenshot dimensions could not be verified", "screenshot capture");
      const evidenceId = createEntityId();
      const provenance: EvidenceProvenance = { evidenceId, runId: input.workspace.runId, attemptId: input.attemptId, captureType: "screenshot", dpr: metadata.width / metrics.viewport.width, scroll: metrics.scroll, clip: { x: 0, y: 0, width: metrics.viewport.width, height: metrics.viewport.height }, url: redactText(metrics.url, [...session.secrets]), viewport: metrics.viewport, browser: "playwright", build: input.build ?? "unknown", capturedAt: new Date().toISOString(), dimensions: { width: metadata.width, height: metadata.height }, ...(input.testcaseId === undefined ? {} : { testcaseId: input.testcaseId }), ...(input.bugId === undefined ? {} : { bugId: input.bugId }) };
      const bundle = await input.workspace.registerEvidenceBundle({ binaries: [{ filename: evidenceFilename(evidenceId, "sanitized-raw"), contents: bytes, mediaType: "image/png", captureType: "screenshot", dimensions: { width: metadata.width, height: metadata.height } }], descriptor: (binaries) => descriptor({ evidenceId, workspace: input.workspace, attemptId: input.attemptId, binary: binaries[0] as { id: string; relativePath: string; sha256: string; mediaType: string }, provenance }), provenance: "runtime" });
      const binary = bundle.binaries[0];
      if (!binary) throw new Error("Evidence bundle did not register a screenshot");
      return { kind: "evidence", evidenceId, rawPath: binary.absolutePath, binaryArtifactId: binary.id, descriptorArtifactId: bundle.descriptor.id };
    } finally { await removeRegionMasks(session, regionIds); }
  } catch (error) {
    return registerGap(input.workspace, input.attemptId, `Capture-time redaction could not be completed safely: ${error instanceof Error ? error.message : String(error)}`, "screenshot capture");
  }
}

/** Persists only scrubbed live telemetry into the supplied workspace; closed sessions are never reconstructed. */
export async function attachEvidence(input: { workspace: RunWorkspace; attemptId: string; callerAttemptId: string; telemetry: "console" | "network" | "log"; protectedEnvironment?: boolean; deterministicScrubberRegistered?: boolean; testcaseId?: string; bugId?: string }): Promise<EvidenceAttachment> {
  const session = activeSession(input.attemptId, input.callerAttemptId);
  if (!session) return registerGap(input.workspace, input.attemptId, "An active caller-owned browser evidence session is required; closed-session telemetry cannot be reconstructed", `${input.telemetry} telemetry`);
  // Known secret redaction is not a policy capable of deterministically
  // scrubbing arbitrary PII. Protected telemetry is therefore absent unless a
  // registered policy explicitly proves all channels are scrubbed.
  if (input.protectedEnvironment === true && input.deterministicScrubberRegistered !== true) {
    return registerGap(input.workspace, input.attemptId, "Protected telemetry is unavailable without a registered deterministic scrubber for every telemetry channel", `${input.telemetry} telemetry`);
  }
  const secrets = [...session.secrets];
  const findings = session.telemetry.findings.filter((finding) => input.telemetry === "log" || finding.kind === input.telemetry).map((finding) => ({ ...finding, message: redactText(finding.message, secrets), ...(finding.url === undefined ? {} : { url: redactText(finding.url, secrets) }) }));
  const payload = input.telemetry === "network" ? { findings, records: session.telemetry.networkRecords.map((record) => redactNetworkRecord(record, secrets)) } : { findings };
  const evidenceId = createEntityId();
  const bytes = Buffer.from(`${JSON.stringify(payload)}\n`);
  const now = new Date().toISOString();
  const provenance: EvidenceProvenance = { evidenceId, runId: input.workspace.runId, attemptId: input.attemptId, captureType: input.telemetry === "log" ? "log" : input.telemetry, dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 1, height: 1 }, url: "about:blank", viewport: { width: 1, height: 1 }, browser: "playwright", build: "unknown", capturedAt: now, dimensions: { width: 1, height: 1 }, ...(input.testcaseId === undefined ? {} : { testcaseId: input.testcaseId }), ...(input.bugId === undefined ? {} : { bugId: input.bugId }) };
  const bundle = await input.workspace.registerEvidenceBundle({ binaries: [{ filename: `${evidenceId}-${input.telemetry}.json`, contents: bytes, mediaType: "application/json", captureType: input.telemetry === "log" ? "log" : input.telemetry }], descriptor: (binaries) => descriptor({ evidenceId, workspace: input.workspace, attemptId: input.attemptId, binary: binaries[0] as { id: string; relativePath: string; sha256: string; mediaType: string }, provenance, telemetryFindings: findings }), provenance: "runtime" });
  const binary = bundle.binaries[0];
  if (!binary) throw new Error("Evidence bundle did not register telemetry");
  return { kind: "evidence", evidenceId, binaryArtifactId: binary.id, descriptorArtifactId: bundle.descriptor.id, telemetry: findings };
}
