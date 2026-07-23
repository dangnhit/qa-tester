import sharp from "sharp";

import { validateAnnotation } from "../contracts/validator.js";
import type { RunWorkspace } from "../core/run-workspace.js";
import { sha256 } from "../core/checksum.js";
import { createEntityId } from "../core/ids.js";
import { evidenceFilename, type EvidenceProvenance } from "./manifest.js";
import type { PixelAnnotation } from "./geometry.js";

export type AnnotatedEvidence = { raw: { sha256: string }; annotated: { absolutePath: string; relativePath: string; sha256: string; artifactId: string }; descriptorArtifactId: string; provenance: EvidenceProvenance & { dimensions: { width: number; height: number } } };

function escapeXml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character] ?? character); }
function valid(annotation: PixelAnnotation, width: number, height: number): boolean { return Number.isFinite(annotation.x) && Number.isFinite(annotation.y) && Number.isFinite(annotation.width) && Number.isFinite(annotation.height) && annotation.x >= 0 && annotation.y >= 0 && annotation.width > 0 && annotation.height > 0 && annotation.x + annotation.width <= width && annotation.y + annotation.height <= height; }
function svg(input: { width: number; height: number; annotations: readonly PixelAnnotation[]; provenance: EvidenceProvenance }): Buffer {
  const footer = escapeXml(`attempt ${input.provenance.attemptId} · ${input.provenance.captureType} · ${input.provenance.capturedAt}`).slice(0, 240);
  const boxes = input.annotations.map((item, index) => `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" fill="none" stroke="#dc2626" stroke-width="2"/><circle cx="${item.x + item.width}" cy="${item.y}" r="10" fill="#dc2626"/><text x="${item.x + item.width - 3}" y="${item.y + 4}" font-family="sans-serif" font-size="10" fill="#ffffff">${index + 1}</text>${item.label === undefined ? "" : `<text x="${item.x + 4}" y="${Math.max(13, item.y - 4)}" font-family="sans-serif" font-size="12" fill="#b91c1c">${escapeXml(item.label)}</text>`}`).join("");
  return Buffer.from(`<svg width="${input.width}" height="${input.height}" xmlns="http://www.w3.org/2000/svg"><g>${boxes}</g><rect x="0" y="${Math.max(0, input.height - 18)}" width="${input.width}" height="18" fill="#111827"/><text x="5" y="${Math.max(13, input.height - 5)}" font-family="sans-serif" font-size="10" fill="#ffffff">${footer}</text></svg>`);
}

/** Creates a separately registered annotated PNG; raw sanitized pixels remain immutable. */
export async function annotateScreenshot(input: { workspace: RunWorkspace; rawEvidenceDescriptorId: string; rawBinaryArtifactId: string; annotations: readonly PixelAnnotation[] }): Promise<AnnotatedEvidence> {
  const source = (await input.workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.id === input.rawEvidenceDescriptorId && artifact.record.type === "evidence");
  const sourceValue = source?.value;
  if (!source || !sourceValue) throw new Error("Raw evidence descriptor is not an authoritative workspace screenshot source");
  if (!Array.isArray(sourceValue.binaryArtifactIds) || !sourceValue.binaryArtifactIds.includes(input.rawBinaryArtifactId) || sourceValue.kind !== "screenshot" || typeof sourceValue.runId !== "string" || sourceValue.runId !== input.workspace.runId || typeof sourceValue.attemptId !== "string" || typeof sourceValue.provenance !== "object" || sourceValue.provenance === null) throw new Error("Raw evidence descriptor is not an authoritative workspace screenshot source");
  const rawRecord = await input.workspace.readArtifactRecord(input.rawBinaryArtifactId);
  if (rawRecord.type !== "evidence" || rawRecord.mediaType !== "image/png" || rawRecord.captureType !== "screenshot") throw new Error("Raw evidence binary is not a sanitized screenshot");
  const rawPath = await input.workspace.resolve(rawRecord.relativePath);
  const metadata = await sharp(rawPath).metadata();
  if (!metadata.width || !metadata.height || input.annotations.some((annotation) => !valid(annotation, metadata.width, metadata.height))) throw new Error("Annotation geometry is invalid or outside the screenshot bounds");
  const dimensions = { width: metadata.width, height: metadata.height };
  const sourceProvenance = sourceValue.provenance as Record<string, unknown>;
  const provenance: EvidenceProvenance & { dimensions: { width: number; height: number } } = { evidenceId: typeof sourceValue.evidenceId === "string" ? sourceValue.evidenceId : input.rawEvidenceDescriptorId, runId: input.workspace.runId, attemptId: sourceValue.attemptId, captureType: "screenshot", dpr: typeof sourceProvenance.dpr === "number" ? sourceProvenance.dpr : 1, scroll: sourceProvenance.scroll as { x: number; y: number }, clip: sourceProvenance.clip as { x: number; y: number; width: number; height: number }, url: String(sourceProvenance.url), viewport: sourceProvenance.viewport as { width: number; height: number }, browser: String(sourceProvenance.browser), build: String(sourceProvenance.build), capturedAt: String(sourceProvenance.capturedAt), dimensions, ...(typeof sourceProvenance.testcaseId === "string" ? { testcaseId: sourceProvenance.testcaseId } : {}), ...(typeof sourceProvenance.bugId === "string" ? { bugId: sourceProvenance.bugId } : {}), cssBoxes: input.annotations.map((annotation) => annotation.cssBox), normalizedPixelBoxes: input.annotations.map((annotation) => ({ ...annotation, cssBox: { ...annotation.cssBox } })) };
  const rawChecksum = await sha256(rawPath);
  const annotationValue = { artifactType: "annotation", schemaVersion: "1.0.0", producerVersion: "0.1.0", evidenceId: provenance.evidenceId, captureType: "screenshot", rawSha256: rawChecksum, annotations: input.annotations.map((annotation) => ({ id: annotation.id, ...(annotation.label === undefined ? {} : { label: annotation.label }), ...(annotation.locator === undefined ? {} : { locator: annotation.locator }), cssBox: annotation.cssBox, pixelBox: { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height } })), provenance: { runId: provenance.runId, attemptId: provenance.attemptId, ...(provenance.testcaseId === undefined ? {} : { testcaseId: provenance.testcaseId }), ...(provenance.bugId === undefined ? {} : { bugId: provenance.bugId }), url: provenance.url, viewport: provenance.viewport, browser: provenance.browser, build: provenance.build, capturedAt: provenance.capturedAt, dimensions, dpr: provenance.dpr, scroll: provenance.scroll, clip: provenance.clip } };
  if (!validateAnnotation(annotationValue).valid) throw new Error("Annotation descriptor does not match its contract");
  const bytes = await sharp(rawPath).composite([{ input: svg({ width: dimensions.width, height: dimensions.height, annotations: input.annotations, provenance }), top: 0, left: 0 }]).png().toBuffer();
  const annotationId = createEntityId();
  const bundle = await input.workspace.registerEvidenceBundle({
    binaries: [{ filename: evidenceFilename(annotationId, "annotated"), contents: bytes, mediaType: "image/png", captureType: "screenshot", dimensions }],
    relationships: [input.rawEvidenceDescriptorId, input.rawBinaryArtifactId],
    provenance: "runtime",
    descriptor: (binaries) => {
      const binary = binaries[0];
      if (!binary?.mediaType) throw new Error("Annotated evidence bundle is missing its binary");
      return { artifactType: "evidence", schemaVersion: "1.0.0", producerVersion: "0.1.0", evidenceId: annotationId, runId: input.workspace.runId, attemptId: provenance.attemptId, pendingAttempt: true, kind: "screenshot", capturedAt: provenance.capturedAt, sha256: binary.sha256, relativePath: binary.relativePath, mediaType: binary.mediaType, binaryArtifactIds: [binary.id], binaryArtifacts: [{ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType }], provenance: { captureType: "screenshot", dimensions, dpr: provenance.dpr, scroll: provenance.scroll, clip: provenance.clip, cssBoxes: provenance.cssBoxes, pixelBoxes: provenance.normalizedPixelBoxes?.map(({ x, y, width, height }) => ({ x, y, width, height })), url: provenance.url, viewport: provenance.viewport, browser: provenance.browser, build: provenance.build, capturedAt: provenance.capturedAt, ...(provenance.testcaseId === undefined ? {} : { testcaseId: provenance.testcaseId }), ...(provenance.bugId === undefined ? {} : { bugId: provenance.bugId }) } };
    },
  });
  const binary = bundle.binaries[0];
  if (!binary) throw new Error("Annotated evidence bundle is missing its binary");
  if (provenance.normalizedPixelBoxes !== undefined) Object.freeze(provenance.normalizedPixelBoxes);
  return { raw: { sha256: rawChecksum }, annotated: { absolutePath: binary.absolutePath, relativePath: binary.relativePath, sha256: binary.sha256, artifactId: binary.id }, descriptorArtifactId: bundle.descriptor.id, provenance: Object.freeze(provenance) };
}
