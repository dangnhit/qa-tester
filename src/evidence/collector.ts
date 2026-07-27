import sharp from "sharp";

import { getActiveBrowserSession } from "../browser/session-registry.js";
import type { ActiveBrowserSession, TelemetryFinding } from "../browser/types.js";
import type { RunWorkspace } from "../core/run-workspace.js";
import { indexByAttemptId } from "../core/artifact-index.js";
import { createEntityId } from "../core/ids.js";
import { evidenceFilename, type EvidenceProvenance } from "./manifest.js";
import { redactNetworkRecord, redactText, validateRedactionPlan, type CssBox, type EvidenceGap, type RedactionPlan } from "./redaction.js";

type GapResult = { kind: "evidence-gap"; gap: EvidenceGap; descriptorArtifactId: string };
export type CapturedEvidence = { kind: "evidence"; evidenceId: string; rawPath: string; binaryArtifactId: string; descriptorArtifactId: string };
export type EvidenceCaptureResult = CapturedEvidence | GapResult;
export type EvidenceAttachment = { kind: "evidence"; evidenceId: string; binaryArtifactId: string; descriptorArtifactId: string; telemetry: readonly TelemetryFinding[] } | GapResult;
export type TelemetryPayload = Readonly<{ findings: readonly TelemetryFinding[]; records?: readonly Readonly<Record<string, unknown>>[] }>;
export type TelemetryScrubber = (payload: TelemetryPayload, context: Readonly<{ attemptId: string; channel: "console" | "network" | "log" }>) => TelemetryPayload | Promise<TelemetryPayload>;
type PageRuntime = { document: { createElement(tag: string): { id: string; setAttribute(name: string, value: string): void; style: Record<string, string> }; documentElement: { appendChild(node: unknown): void }; getElementById(id: string): { remove(): void } | null }; scrollX: number; scrollY: number; innerWidth: number; innerHeight: number; location: { href: string } };

function activeSession(attemptId: string, callerAttemptId: string): ActiveBrowserSession | undefined {
  return attemptId === callerAttemptId ? getActiveBrowserSession(attemptId) : undefined;
}

type AttemptBinding = Readonly<{ artifactId: string; testCaseId: string; testCaseRevisionId: string; testCaseInstanceId: string }>;

async function attemptBinding(workspace: RunWorkspace, attemptId: string): Promise<AttemptBinding | undefined> {
  // The index maps to the FULL bucket, so `length === 1` still refuses an ambiguous attempt (an
  // evidence gap, not a binding) rather than silently taking the first of several.
  const registered = await workspace.readRegisteredArtifacts();
  const matches = indexByAttemptId(
    registered.filter((artifact) => artifact.record.type === "test-result"),
    (artifact) => artifact.value.attemptId,
  ).get(attemptId);
  const attempt = matches.length === 1 ? matches[0] : undefined;
  if (!attempt || typeof attempt.value.testCaseId !== "string" || typeof attempt.value.testCaseRevisionId !== "string" || typeof attempt.value.testCaseInstanceId !== "string") return undefined;
  return { artifactId: attempt.record.id, testCaseId: attempt.value.testCaseId, testCaseRevisionId: attempt.value.testCaseRevisionId, testCaseInstanceId: attempt.value.testCaseInstanceId };
}

async function registerGap(workspace: RunWorkspace, attemptId: string, reason: string, affectedClaim: string): Promise<GapResult> {
  const binding = await attemptBinding(workspace, attemptId);
  const gap = binding === undefined
    ? { artifactType: "evidence-gap" as const, schemaVersion: "1.0.0" as const, producerVersion: "0.1.0", evidenceGapId: createEntityId(), runId: workspace.runId, scope: "operational" as const, reason, affectedClaim }
    : { artifactType: "evidence-gap" as const, schemaVersion: "1.0.0" as const, producerVersion: "0.1.0", evidenceGapId: createEntityId(), runId: workspace.runId, scope: "attempt" as const, attemptId, testCaseId: binding.testCaseId, testCaseRevisionId: binding.testCaseRevisionId, testCaseInstanceId: binding.testCaseInstanceId, reason, affectedClaim };
  const record = await workspace.registerArtifactValue({ type: "evidence-gap", value: gap, relationships: binding === undefined ? [] : [binding.artifactId], provenance: "runtime" });
  return { kind: "evidence-gap", descriptorArtifactId: record.id, gap };
}

/** Registers an explicit attempt-bound gap when an evidence channel cannot be persisted safely. */
export function recordEvidenceGap(input: { workspace: RunWorkspace; attemptId: string; reason: string; affectedClaim: string }): Promise<GapResult> {
  return registerGap(input.workspace, input.attemptId, input.reason, input.affectedClaim);
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

/** Geometry is emitted only for a screenshot, which is the only capture that measures it. For a
 *  trace/console/network/log descriptor, `viewport` is carried through only if the caller's
 *  `EvidenceProvenance` set it, never defaulted — the evidence contract forbids inventing it, so a
 *  reintroduced default would fail validation loudly. That conditional spread keeps this function total
 *  over `EvidenceProvenance`'s non-screenshot variants, but it is currently unexercised: the only
 *  trace-evidence writer (`src/operations/run-workflow.ts`) builds its descriptor inline and never calls
 *  this function, and the telemetry path that does call it only ever passes `console`/`network`/`log`. */
function provenanceValue(provenance: EvidenceProvenance) {
  const shared = { url: provenance.url, browser: provenance.browser, build: provenance.build, capturedAt: provenance.capturedAt, ...(provenance.testcaseId === undefined ? {} : { testcaseId: provenance.testcaseId }), ...(provenance.bugId === undefined ? {} : { bugId: provenance.bugId }) };
  if (provenance.captureType !== "screenshot") {
    return { captureType: provenance.captureType, ...(provenance.viewport === undefined ? {} : { viewport: provenance.viewport }), ...shared };
  }
  return {
    captureType: provenance.captureType, dimensions: provenance.dimensions, dpr: provenance.dpr, scroll: provenance.scroll, clip: provenance.clip,
    ...(provenance.cssBoxes === undefined ? {} : { cssBoxes: provenance.cssBoxes }),
    ...(provenance.normalizedPixelBoxes === undefined ? {} : { pixelBoxes: provenance.normalizedPixelBoxes.map(({ x, y, width, height }) => ({ x, y, width, height })) }),
    viewport: provenance.viewport, ...shared,
  };
}

function descriptor(input: { evidenceId: string; workspace: RunWorkspace; attemptId: string; binding: AttemptBinding; binary: { id: string; relativePath: string; sha256: string; mediaType?: string }; provenance: EvidenceProvenance; telemetryFindings?: readonly TelemetryFinding[] }) {
  if (!input.binary.mediaType) throw new Error("Evidence media type is required");
  if (input.provenance.captureType === "screenshot" && !input.provenance.dimensions) throw new Error("Screenshot evidence dimensions are required");
  return {
    artifactType: "evidence", schemaVersion: "2.0.0", producerVersion: "0.2.0", evidenceId: input.evidenceId, runId: input.workspace.runId,
    subject: { kind: "attempt", attemptId: input.attemptId, testCaseId: input.binding.testCaseId, testCaseRevisionId: input.binding.testCaseRevisionId, testCaseInstanceId: input.binding.testCaseInstanceId },
    kind: input.provenance.captureType, capturedAt: input.provenance.capturedAt, sha256: input.binary.sha256, relativePath: input.binary.relativePath, mediaType: input.binary.mediaType, binaryArtifactIds: [input.binary.id], binaryArtifacts: [{ id: input.binary.id, relativePath: input.binary.relativePath, sha256: input.binary.sha256, mediaType: input.binary.mediaType }],
    ...(input.telemetryFindings === undefined ? {} : { telemetryFindings: input.telemetryFindings
      .filter((finding) => finding.kind === "console" || finding.kind === "network")
      .map((finding) => ({ kind: finding.kind, level: finding.level ?? "error", message: finding.message })) }),
    provenance: provenanceValue(input.provenance),
  };
}

/** Captures a screenshot only when every required mask can be proven before pixels persist; otherwise registers an Evidence Gap. */
export async function captureEvidence(input: { workspace: RunWorkspace; attemptId: string; callerAttemptId: string; protectedEnvironment: boolean; redaction: Pick<RedactionPlan, "domSelectors" | "regions">; build?: string; testcaseId?: string; bugId?: string }): Promise<EvidenceCaptureResult> {
  const session = activeSession(input.attemptId, input.callerAttemptId);
  if (!session) return registerGap(input.workspace, input.attemptId, "No active caller-owned browser evidence session is available", "screenshot capture");
  if (session.secrets.size > 0) return registerGap(input.workspace, input.attemptId, "Screenshot pixels are unavailable after secret resolution because deterministic secret-derived masking cannot be proven", "screenshot capture");
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
      const binding = await attemptBinding(input.workspace, input.attemptId);
      if (!binding) return registerGap(input.workspace, input.attemptId, "The evidence attempt is not a registered canonical test result", "screenshot capture");
      const evidenceId = createEntityId();
      const provenance: EvidenceProvenance = { evidenceId, runId: input.workspace.runId, attemptId: input.attemptId, captureType: "screenshot", dpr: metadata.width / metrics.viewport.width, scroll: metrics.scroll, clip: { x: 0, y: 0, width: metrics.viewport.width, height: metrics.viewport.height }, url: redactText(metrics.url, [...session.secrets]), viewport: metrics.viewport, browser: "playwright", build: input.build ?? "unknown", capturedAt: new Date().toISOString(), dimensions: { width: metadata.width, height: metadata.height }, ...(input.testcaseId === undefined ? {} : { testcaseId: input.testcaseId }), ...(input.bugId === undefined ? {} : { bugId: input.bugId }) };
      const bundle = await input.workspace.registerEvidenceBundle({ binaries: [{ filename: evidenceFilename(evidenceId, "sanitized-raw"), contents: bytes, mediaType: "image/png", captureType: "screenshot", dimensions: { width: metadata.width, height: metadata.height } }], descriptor: (binaries) => descriptor({ evidenceId, workspace: input.workspace, attemptId: input.attemptId, binding, binary: binaries[0] as { id: string; relativePath: string; sha256: string; mediaType: string }, provenance }), relationships: [binding.artifactId], provenance: "runtime" });
      const binary = bundle.binaries[0];
      if (!binary) throw new Error("Evidence bundle did not register a screenshot");
      return { kind: "evidence", evidenceId, rawPath: binary.absolutePath, binaryArtifactId: binary.id, descriptorArtifactId: bundle.descriptor.id };
    } finally { await removeRegionMasks(session, regionIds); }
  } catch (error) {
    return registerGap(input.workspace, input.attemptId, `Capture-time redaction could not be completed safely: ${error instanceof Error ? error.message : String(error)}`, "screenshot capture");
  }
}

/** Persists only scrubbed live telemetry into the supplied workspace; closed sessions are never reconstructed. */
export async function attachEvidence(input: { workspace: RunWorkspace; attemptId: string; callerAttemptId: string; telemetry: "console" | "network" | "log"; protectedEnvironment?: boolean; telemetryScrubber?: TelemetryScrubber; testcaseId?: string; bugId?: string }): Promise<EvidenceAttachment> {
  const session = activeSession(input.attemptId, input.callerAttemptId);
  if (!session) return registerGap(input.workspace, input.attemptId, "An active caller-owned browser evidence session is required; closed-session telemetry cannot be reconstructed", `${input.telemetry} telemetry`);
  // Known secret redaction is not a policy capable of deterministically
  // scrubbing arbitrary PII. Protected telemetry is therefore absent unless a
  // registered policy explicitly proves all channels are scrubbed.
  if (input.protectedEnvironment === true && input.telemetryScrubber === undefined) {
    return registerGap(input.workspace, input.attemptId, "Protected telemetry is unavailable without a registered deterministic scrubber for every telemetry channel", `${input.telemetry} telemetry`);
  }
  const secrets = [...session.secrets];
  const findings = session.telemetry.findings.filter((finding) => input.telemetry === "log" || finding.kind === input.telemetry).map((finding) => ({ ...finding, message: redactText(finding.message, secrets), ...(finding.url === undefined ? {} : { url: redactText(finding.url, secrets) }) }));
  const initialPayload: TelemetryPayload = input.telemetry === "network" ? { findings, records: session.telemetry.networkRecords.map((record) => redactNetworkRecord(record, secrets)) } : { findings };
  let payload = initialPayload;
  if (input.telemetryScrubber !== undefined) {
    try {
      payload = await input.telemetryScrubber(initialPayload, { attemptId: input.attemptId, channel: input.telemetry });
      if (!payload || !Array.isArray(payload.findings)) throw new Error("scrubber returned an invalid telemetry payload");
      JSON.stringify(payload);
    } catch (error) {
      return registerGap(input.workspace, input.attemptId, `Protected telemetry scrubber failed safely: ${error instanceof Error ? error.message : String(error)}`, `${input.telemetry} telemetry`);
    }
  }
  const scrubbedFindings = payload.findings.map((finding) => ({ ...finding, message: redactText(finding.message, secrets), ...(finding.url === undefined ? {} : { url: redactText(finding.url, secrets) }) }));
  const binding = await attemptBinding(input.workspace, input.attemptId);
  if (!binding) return registerGap(input.workspace, input.attemptId, "The evidence attempt is not a registered canonical test result", `${input.telemetry} telemetry`);
  const evidenceId = createEntityId();
  const bytes = Buffer.from(`${JSON.stringify(payload)}\n`);
  const now = new Date().toISOString();
  // Telemetry is captured from the session's recorded channels, not from a rendered page: this capture
  // measures no dimensions, device pixel ratio, scroll position, or clip. Those fields are therefore
  // absent rather than defaulted — the evidence contract forbids them on a non-screenshot capture.
  const provenance: EvidenceProvenance = { evidenceId, runId: input.workspace.runId, attemptId: input.attemptId, captureType: input.telemetry === "log" ? "log" : input.telemetry, url: "about:blank", browser: "playwright", build: "unknown", capturedAt: now, ...(input.testcaseId === undefined ? {} : { testcaseId: input.testcaseId }), ...(input.bugId === undefined ? {} : { bugId: input.bugId }) };
  const bundle = await input.workspace.registerEvidenceBundle({ binaries: [{ filename: `${evidenceId}-${input.telemetry}.json`, contents: bytes, mediaType: "application/json", captureType: input.telemetry === "log" ? "log" : input.telemetry }], descriptor: (binaries) => descriptor({ evidenceId, workspace: input.workspace, attemptId: input.attemptId, binding, binary: binaries[0] as { id: string; relativePath: string; sha256: string; mediaType: string }, provenance, telemetryFindings: scrubbedFindings }), relationships: [binding.artifactId], provenance: "runtime" });
  const binary = bundle.binaries[0];
  if (!binary) throw new Error("Evidence bundle did not register telemetry");
  return { kind: "evidence", evidenceId, binaryArtifactId: binary.id, descriptorArtifactId: bundle.descriptor.id, telemetry: scrubbedFindings };
}
