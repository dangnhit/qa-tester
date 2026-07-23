import sharp from "sharp";

import { createEvidenceManifest, type EvidenceManifest, type EvidenceProvenance } from "./manifest.js";
import type { PixelAnnotation } from "./geometry.js";

export type AnnotatedEvidence = Omit<EvidenceManifest, "provenance"> & { provenance: EvidenceProvenance & { dimensions: { width: number; height: number } }; dimensions: { width: number; height: number } };

function escapeXml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character] ?? character); }
function svg(input: { width: number; height: number; annotations: readonly PixelAnnotation[]; provenance: EvidenceProvenance }): Buffer {
  const footer = `attempt ${input.provenance.attemptId} · ${input.provenance.captureType} · ${input.provenance.capturedAt}`;
  const boxes = input.annotations.map((item, index) => {
    const label = item.label === undefined ? "" : `<text x="${item.x + 5}" y="${Math.max(14, item.y - 5)}" font-family="sans-serif" font-size="12" fill="#b91c1c">${escapeXml(item.label)}</text>`;
    const markerX = item.x + item.width;
    const markerY = item.y;
    return `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" fill="none" stroke="#dc2626" stroke-width="2"/><line x1="${markerX}" y1="${markerY}" x2="${markerX + 12}" y2="${Math.max(8, markerY - 12)}" stroke="#dc2626" stroke-width="2"/><circle cx="${markerX + 16}" cy="${Math.max(12, markerY - 16)}" r="10" fill="#dc2626"/><text x="${markerX + 13}" y="${Math.max(16, markerY - 12)}" font-family="sans-serif" font-size="12" fill="#ffffff">${index + 1}</text>${label}`;
  }).join("");
  const footerHeight = 18;
  return Buffer.from(`<svg width="${input.width}" height="${input.height}" xmlns="http://www.w3.org/2000/svg"><g>${boxes}</g><rect x="0" y="${Math.max(0, input.height - footerHeight)}" width="${input.width}" height="${footerHeight}" fill="#111827" fill-opacity="0.86"/><text x="5" y="${Math.max(13, input.height - 5)}" font-family="sans-serif" font-size="10" fill="#ffffff">${escapeXml(footer).slice(0, 240)}</text></svg>`);
}

/** Adds only sanitized, deterministic SVG overlays and never mutates the raw evidence file. */
export async function annotateScreenshot(input: { rawPath: string; outputPath: string; workspaceRoot?: string; provenance: EvidenceProvenance; annotations: readonly PixelAnnotation[] }): Promise<AnnotatedEvidence> {
  if (input.rawPath === input.outputPath) throw new Error("Annotated evidence must be separate from sanitized raw evidence");
  const metadata = await sharp(input.rawPath).metadata();
  if (metadata.width === undefined || metadata.height === undefined) throw new Error("Screenshot dimensions are unavailable");
  const overlay = svg({ width: metadata.width, height: metadata.height, annotations: input.annotations, provenance: input.provenance });
  await sharp(input.rawPath).composite([{ input: overlay, top: 0, left: 0 }]).png().toFile(input.outputPath);
  const dimensions = { width: metadata.width, height: metadata.height };
  const manifest = await createEvidenceManifest({ ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }), rawPath: input.rawPath, annotatedPath: input.outputPath, provenance: { ...input.provenance, dimensions, cssBoxes: input.annotations.map((annotation) => annotation.cssBox), normalizedPixelBoxes: input.annotations } });
  return { ...manifest, provenance: manifest.provenance as EvidenceProvenance & { dimensions: { width: number; height: number } }, dimensions };
}
