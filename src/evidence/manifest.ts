import { basename, relative, resolve } from "node:path";

import { sha256 } from "../core/checksum.js";
import { assertPathWithin } from "../core/fs.js";
import type { PixelAnnotation } from "./geometry.js";

export type EvidenceProvenance = { evidenceId: string; runId: string; attemptId: string; testcaseId?: string; bugId?: string; captureType: "screenshot" | "trace" | "console" | "network" | "log"; dpr: number; scroll: { x: number; y: number }; clip: { x: number; y: number; width: number; height: number }; url: string; viewport: { width: number; height: number }; browser: string; build: string; capturedAt: string; dimensions?: { width: number; height: number }; cssBoxes?: readonly { x: number; y: number; width: number; height: number }[]; normalizedPixelBoxes?: readonly PixelAnnotation[] };
export type EvidenceManifest = Readonly<{ version: "1.0.0"; raw: { relativePath: string; sha256: string }; annotated?: { relativePath: string; sha256: string }; provenance: EvidenceProvenance }>;

function immutable<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function relativePath(root: string | undefined, path: string): string {
  if (root === undefined) return resolve(path);
  const value = relative(resolve(root), resolve(path));
  if (value === "" || value.startsWith("..")) throw new Error("Evidence path escapes its workspace");
  return value;
}

export async function createEvidenceManifest(input: { workspaceRoot?: string; rawPath: string; annotatedPath?: string; provenance: EvidenceProvenance }): Promise<EvidenceManifest> {
  if (input.workspaceRoot !== undefined) {
    await assertPathWithin(input.workspaceRoot, input.rawPath);
    if (input.annotatedPath !== undefined) await assertPathWithin(input.workspaceRoot, input.annotatedPath);
  }
  if (input.annotatedPath !== undefined && resolve(input.rawPath) === resolve(input.annotatedPath)) throw new Error("Annotated evidence must be a separate file");
  return immutable({
    version: "1.0.0",
    raw: { relativePath: relativePath(input.workspaceRoot, input.rawPath), sha256: await sha256(input.rawPath) },
    ...(input.annotatedPath === undefined ? {} : { annotated: { relativePath: relativePath(input.workspaceRoot, input.annotatedPath), sha256: await sha256(input.annotatedPath) } }),
    provenance: { ...input.provenance, ...(input.provenance.cssBoxes === undefined ? {} : { cssBoxes: input.provenance.cssBoxes.map((box) => ({ ...box })) }), ...(input.provenance.normalizedPixelBoxes === undefined ? {} : { normalizedPixelBoxes: input.provenance.normalizedPixelBoxes.map((box) => ({ ...box, cssBox: { ...box.cssBox } })) }) },
  });
}

export function evidenceFilename(evidenceId: string, suffix: "sanitized-raw" | "annotated"): string { return `${evidenceId}-${suffix}.png`; }
export function displayEvidencePath(path: string): string { return basename(path); }
