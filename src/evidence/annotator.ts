import { relative } from "node:path";

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
export async function annotateScreenshot(input: { workspace: RunWorkspace; rawPath: string; rawBinaryArtifactId: string; provenance: EvidenceProvenance; annotations: readonly PixelAnnotation[] }): Promise<AnnotatedEvidence> {
  const rawRelativePath = relative(input.workspace.path, input.rawPath);
  if (rawRelativePath === "" || rawRelativePath.startsWith("..")) throw new Error("Raw evidence path escapes its workspace");
  const rawPath = await input.workspace.resolve(rawRelativePath);
  const metadata = await sharp(rawPath).metadata();
  if (!metadata.width || !metadata.height || input.annotations.some((annotation) => !valid(annotation, metadata.width, metadata.height))) throw new Error("Annotation geometry is invalid or outside the screenshot bounds");
  const dimensions = { width: metadata.width, height: metadata.height };
  const provenance: EvidenceProvenance & { dimensions: { width: number; height: number } } = { ...input.provenance, dimensions, cssBoxes: input.annotations.map((annotation) => annotation.cssBox), normalizedPixelBoxes: input.annotations.map((annotation) => ({ ...annotation, cssBox: { ...annotation.cssBox } })) };
  const rawChecksum = await sha256(rawPath);
  const annotationValue = { artifactType: "annotation", schemaVersion: "1.0.0", producerVersion: "0.1.0", evidenceId: input.provenance.evidenceId, captureType: "screenshot", rawSha256: rawChecksum, annotations: input.annotations.map((annotation) => ({ id: annotation.id, ...(annotation.label === undefined ? {} : { label: annotation.label }), ...(annotation.locator === undefined ? {} : { locator: annotation.locator }), cssBox: annotation.cssBox, pixelBox: { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height } })), provenance: { runId: provenance.runId, attemptId: provenance.attemptId, ...(provenance.testcaseId === undefined ? {} : { testcaseId: provenance.testcaseId }), ...(provenance.bugId === undefined ? {} : { bugId: provenance.bugId }), url: provenance.url, viewport: provenance.viewport, browser: provenance.browser, build: provenance.build, capturedAt: provenance.capturedAt, dimensions, dpr: provenance.dpr, scroll: provenance.scroll, clip: provenance.clip } };
  if (!validateAnnotation(annotationValue).valid) throw new Error("Annotation descriptor does not match its contract");
  const bytes = await sharp(rawPath).composite([{ input: svg({ width: dimensions.width, height: dimensions.height, annotations: input.annotations, provenance }), top: 0, left: 0 }]).png().toBuffer();
  const annotationId = createEntityId();
  const binary = await input.workspace.registerBinaryArtifact({ type: "evidence", filename: evidenceFilename(annotationId, "annotated"), contents: bytes, mediaType: "image/png", captureType: "screenshot", dimensions, relationships: [input.rawBinaryArtifactId], provenance: "runtime" });
  const descriptor = await input.workspace.registerArtifactValue({ type: "evidence", value: { artifactType: "evidence", schemaVersion: "1.0.0", producerVersion: "0.1.0", evidenceId: annotationId, runId: input.workspace.runId, attemptId: provenance.attemptId, pendingAttempt: true, kind: "screenshot", capturedAt: provenance.capturedAt, sha256: binary.sha256, relativePath: binary.relativePath, mediaType: "image/png", binaryArtifactIds: [input.rawBinaryArtifactId, binary.id], provenance: { captureType: "screenshot", dimensions, dpr: provenance.dpr, scroll: provenance.scroll, clip: provenance.clip, cssBoxes: provenance.cssBoxes, pixelBoxes: provenance.normalizedPixelBoxes?.map(({ x, y, width, height }) => ({ x, y, width, height })), url: provenance.url, viewport: provenance.viewport, browser: provenance.browser, build: provenance.build, capturedAt: provenance.capturedAt, ...(provenance.testcaseId === undefined ? {} : { testcaseId: provenance.testcaseId }), ...(provenance.bugId === undefined ? {} : { bugId: provenance.bugId }) } }, relationships: [input.rawBinaryArtifactId, binary.id], provenance: "runtime" });
  if (provenance.normalizedPixelBoxes !== undefined) Object.freeze(provenance.normalizedPixelBoxes);
  return { raw: { sha256: rawChecksum }, annotated: { absolutePath: binary.absolutePath, relativePath: binary.relativePath, sha256: binary.sha256, artifactId: binary.id }, descriptorArtifactId: descriptor.id, provenance: Object.freeze(provenance) };
}
