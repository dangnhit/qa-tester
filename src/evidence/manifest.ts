import type { PixelAnnotation } from "./geometry.js";

/** What every capture can honestly state regardless of channel; file registration belongs exclusively to RunWorkspace. */
type EvidenceProvenanceBase = {
  evidenceId: string;
  runId: string;
  attemptId: string;
  testcaseId?: string;
  bugId?: string;
  url: string;
  browser: string;
  build: string;
  capturedAt: string;
};

/** A screenshot is the only capture that measures page geometry, so it is the only variant that carries it. */
export type ScreenshotEvidenceProvenance = EvidenceProvenanceBase & {
  captureType: "screenshot";
  dimensions: { width: number; height: number };
  dpr: number;
  scroll: { x: number; y: number };
  clip: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  cssBoxes?: readonly { x: number; y: number; width: number; height: number }[];
  normalizedPixelBoxes?: readonly PixelAnnotation[];
  locator?: string;
  annotationLabels?: readonly string[];
};

/** Trace/console/network/log captures measure no geometry. `viewport` is present only when the capture
 *  genuinely knows one (the trace path does); every other geometry field is absent because it is unknown,
 *  and the evidence contract forbids inventing it. */
export type NonVisualEvidenceProvenance = EvidenceProvenanceBase & {
  captureType: "trace" | "console" | "network" | "log";
  viewport?: { width: number; height: number };
};

/** Provenance held by canonical evidence descriptors, discriminated by `captureType`. */
export type EvidenceProvenance = ScreenshotEvidenceProvenance | NonVisualEvidenceProvenance;

export function evidenceFilename(evidenceId: string, suffix: "sanitized-raw" | "annotated"): string { return `${evidenceId}-${suffix}.png`; }
