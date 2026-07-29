import { readFile } from "node:fs/promises";

import sharp from "sharp";

import { validateAnnotation } from "../contracts/validator.js";
import type { RunWorkspace } from "../core/run-workspace.js";
import { indexByAttemptId } from "../core/artifact-index.js";
import { evidenceSubject } from "../core/artifact-record.js";
import { sha256Bytes } from "../core/checksum.js";
import { createEntityId } from "../core/ids.js";
import { evidenceFilename, type EvidenceProvenance, type ScreenshotEvidenceProvenance } from "./manifest.js";
import type { PixelAnnotation } from "./geometry.js";

export type AnnotatedEvidence = { raw: { sha256: string }; annotated: { absolutePath: string; relativePath: string; sha256: string; artifactId: string }; descriptorArtifactId: string; provenance: ScreenshotEvidenceProvenance };

function escapeXml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character] ?? character); }
function escapedText(value: string, limit: number): string { return escapeXml(value.slice(0, limit)); }
function valid(annotation: PixelAnnotation, width: number, height: number): boolean { return Number.isFinite(annotation.x) && Number.isFinite(annotation.y) && Number.isFinite(annotation.width) && Number.isFinite(annotation.height) && annotation.x >= 0 && annotation.y >= 0 && annotation.width > 0 && annotation.height > 0 && annotation.x + annotation.width <= width && annotation.y + annotation.height <= height; }
function svg(input: { width: number; height: number; annotations: readonly PixelAnnotation[]; provenance: EvidenceProvenance }): Buffer {
  const footer = escapedText(`attempt ${input.provenance.attemptId} · ${input.provenance.captureType} · ${input.provenance.capturedAt}`, 240);
  const boxes = input.annotations.map((item, index) => `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" fill="none" stroke="#dc2626" stroke-width="2"/><circle cx="${item.x + item.width}" cy="${item.y}" r="10" fill="#dc2626"/><text x="${item.x + item.width - 3}" y="${item.y + 4}" font-family="sans-serif" font-size="10" fill="#ffffff">${index + 1}</text>${item.label === undefined ? "" : `<text x="${item.x + 4}" y="${Math.max(13, item.y - 4)}" font-family="sans-serif" font-size="12" fill="#b91c1c">${escapedText(item.label, 120)}</text>`}`).join("");
  return Buffer.from(`<svg width="${input.width}" height="${input.height}" xmlns="http://www.w3.org/2000/svg"><g>${boxes}</g><rect x="0" y="${Math.max(0, input.height - 18)}" width="${input.width}" height="18" fill="#111827"/><text x="5" y="${Math.max(13, input.height - 5)}" font-family="sans-serif" font-size="10" fill="#ffffff">${footer}</text></svg>`);
}

/** Creates a separately registered annotated PNG; raw sanitized pixels remain immutable. */
export async function annotateScreenshot(input: { workspace: RunWorkspace; rawEvidenceDescriptorId: string; rawBinaryArtifactId: string; annotations: readonly PixelAnnotation[] }): Promise<AnnotatedEvidence> {
  const artifacts = await input.workspace.readRegisteredArtifacts();
  const source = artifacts.find((artifact) => artifact.record.id === input.rawEvidenceDescriptorId && artifact.record.type === "evidence");
  const sourceValue = source?.value;
  if (!source || !sourceValue) throw new Error("Raw evidence descriptor is not an authoritative workspace screenshot source");
  // Annotation derives from one canonical attempt, so only an `attempt`-subject source qualifies. An
  // `observed-execution` subject binds no test result and is rejected here rather than silently skipped.
  const subject = evidenceSubject(sourceValue);
  if (!Array.isArray(sourceValue.binaryArtifactIds) || sourceValue.binaryArtifactIds[0] !== input.rawBinaryArtifactId || sourceValue.kind !== "screenshot" || typeof sourceValue.runId !== "string" || sourceValue.runId !== input.workspace.runId || subject?.kind !== "attempt" || typeof sourceValue.provenance !== "object" || sourceValue.provenance === null) throw new Error("Raw evidence descriptor is not an authoritative workspace screenshot source");
  // Attempt equality was one conjunct of the original single `.find()`; it now selects the bucket and
  // the rest stays a `.find()` over it. The bucket is in `artifacts` order, so the artifact found is
  // still the FIRST registered test result satisfying the whole conjunction.
  const attempt = indexByAttemptId(
    artifacts.filter((artifact) => artifact.record.type === "test-result"),
    (artifact) => artifact.value.attemptId,
  ).get(subject.attemptId).find((artifact) => source.record.relationships.includes(artifact.record.id)
    && artifact.value.testCaseId === subject.testCaseId
    && artifact.value.testCaseRevisionId === subject.testCaseRevisionId
    && artifact.value.testCaseInstanceId === subject.testCaseInstanceId);
  if (!attempt) throw new Error("Raw screenshot is not bound to one canonical test result");
  const rawRecord = await input.workspace.readArtifactRecord(input.rawBinaryArtifactId);
  if (rawRecord.type !== "evidence" || rawRecord.mediaType !== "image/png" || rawRecord.captureType !== "screenshot") throw new Error("Raw evidence binary is not a sanitized screenshot");
  const rawPath = await input.workspace.resolve(rawRecord.relativePath);
  // Read the bytes once and hand libvips a Buffer rather than the path. libvips' operation cache
  // retains an open descriptor on a file input, and on Windows that descriptor makes the registered
  // evidence binary undeletable — `rm(workspaceRoot, { recursive: true })` fails EBUSY long after the
  // annotation returns. `collector.ts` already passes bytes for exactly this shape of call; this was
  // the one path-input left. It also removes a second read: the checksum below reuses these bytes.
  const rawBytes = await readFile(rawPath);
  const metadata = await sharp(rawBytes).metadata();
  if (!metadata.width || !metadata.height || input.annotations.some((annotation) => !valid(annotation, metadata.width, metadata.height))) throw new Error("Annotation geometry is invalid or outside the screenshot bounds");
  const dimensions = { width: metadata.width, height: metadata.height };
  const sourceProvenance = sourceValue.provenance as Record<string, unknown>;
  const locator = input.annotations.find((annotation) => annotation.locator !== undefined)?.locator;
  const annotationLabels = input.annotations.flatMap((annotation) => annotation.label === undefined ? [] : [annotation.label]);
  const provenance: ScreenshotEvidenceProvenance = {
    evidenceId: typeof sourceValue.evidenceId === "string" ? sourceValue.evidenceId : input.rawEvidenceDescriptorId,
    runId: input.workspace.runId,
    attemptId: subject.attemptId,
    captureType: "screenshot",
    dpr: typeof sourceProvenance.dpr === "number" ? sourceProvenance.dpr : 1,
    scroll: sourceProvenance.scroll as { x: number; y: number },
    clip: sourceProvenance.clip as { x: number; y: number; width: number; height: number },
    url: String(sourceProvenance.url),
    viewport: sourceProvenance.viewport as { width: number; height: number },
    browser: String(sourceProvenance.browser),
    build: String(sourceProvenance.build),
    capturedAt: String(sourceProvenance.capturedAt),
    dimensions,
    ...(typeof sourceProvenance.testcaseId === "string" ? { testcaseId: sourceProvenance.testcaseId } : {}),
    ...(typeof sourceProvenance.bugId === "string" ? { bugId: sourceProvenance.bugId } : {}),
    cssBoxes: input.annotations.map((annotation) => annotation.cssBox),
    normalizedPixelBoxes: input.annotations.map((annotation) => ({ ...annotation, cssBox: { ...annotation.cssBox } })),
    ...(locator === undefined ? {} : { locator }),
    ...(annotationLabels.length === 0 ? {} : { annotationLabels }),
  };
  const rawChecksum = sha256Bytes(rawBytes);
  const annotationValue = { artifactType: "annotation", schemaVersion: "1.0.0", producerVersion: "0.1.0", evidenceId: provenance.evidenceId, captureType: "screenshot", sourceEvidenceArtifactId: source.record.id, sourceEvidenceSha256: source.record.sha256, sourceBinaryArtifactId: rawRecord.id, rawSha256: rawChecksum, annotations: input.annotations.map((annotation) => ({ id: annotation.id, ...(annotation.label === undefined ? {} : { label: annotation.label }), ...(annotation.locator === undefined ? {} : { locator: annotation.locator }), cssBox: annotation.cssBox, pixelBox: { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height } })), provenance: { runId: provenance.runId, attemptId: provenance.attemptId, ...(provenance.testcaseId === undefined ? {} : { testcaseId: provenance.testcaseId }), ...(provenance.bugId === undefined ? {} : { bugId: provenance.bugId }), url: provenance.url, viewport: provenance.viewport, browser: provenance.browser, build: provenance.build, capturedAt: provenance.capturedAt, dimensions, dpr: provenance.dpr, scroll: provenance.scroll, clip: provenance.clip } };
  if (!validateAnnotation(annotationValue).valid) throw new Error("Annotation descriptor does not match its contract");
  const bytes = await sharp(rawBytes).composite([{ input: svg({ width: dimensions.width, height: dimensions.height, annotations: input.annotations, provenance }), top: 0, left: 0 }]).png().toBuffer();
  const annotationId = createEntityId();
  const bundle = await input.workspace.registerEvidenceBundle({
    binaries: [{ filename: evidenceFilename(annotationId, "annotated"), contents: bytes, mediaType: "image/png", captureType: "screenshot", dimensions }],
    relationships: [attempt.record.id, input.rawEvidenceDescriptorId, input.rawBinaryArtifactId],
    provenance: "runtime",
    descriptor: (binaries) => {
      const binary = binaries[0];
      if (!binary?.mediaType) throw new Error("Annotated evidence bundle is missing its binary");
      return { artifactType: "evidence", schemaVersion: "3.0.0", producerVersion: "0.2.0", evidenceId: annotationId, runId: input.workspace.runId, subject: { kind: "attempt", attemptId: subject.attemptId, testCaseId: subject.testCaseId, testCaseRevisionId: subject.testCaseRevisionId, testCaseInstanceId: subject.testCaseInstanceId }, kind: "screenshot", capturedAt: provenance.capturedAt, sha256: binary.sha256, relativePath: binary.relativePath, mediaType: binary.mediaType, binaryArtifactIds: [binary.id], binaryArtifacts: [{ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType }], derivation: { sourceEvidenceArtifactId: source.record.id, sourceEvidenceSha256: source.record.sha256, sourceBinaryArtifactId: rawRecord.id, sourceRawSha256: rawChecksum }, provenance: { captureType: "screenshot", dimensions, dpr: provenance.dpr, scroll: provenance.scroll, clip: provenance.clip, cssBoxes: provenance.cssBoxes, pixelBoxes: provenance.normalizedPixelBoxes?.map(({ x, y, width, height }) => ({ x, y, width, height })), ...(provenance.locator === undefined ? {} : { locator: provenance.locator }), ...(provenance.annotationLabels === undefined ? {} : { annotationLabels: provenance.annotationLabels }), url: provenance.url, viewport: provenance.viewport, browser: provenance.browser, build: provenance.build, capturedAt: provenance.capturedAt, ...(provenance.testcaseId === undefined ? {} : { testcaseId: provenance.testcaseId }), ...(provenance.bugId === undefined ? {} : { bugId: provenance.bugId }) } };
    },
  });
  const binary = bundle.binaries[0];
  if (!binary) throw new Error("Annotated evidence bundle is missing its binary");
  if (provenance.normalizedPixelBoxes !== undefined) Object.freeze(provenance.normalizedPixelBoxes);
  return { raw: { sha256: rawChecksum }, annotated: { absolutePath: binary.absolutePath, relativePath: binary.relativePath, sha256: binary.sha256, artifactId: binary.id }, descriptorArtifactId: bundle.descriptor.id, provenance: Object.freeze(provenance) };
}
