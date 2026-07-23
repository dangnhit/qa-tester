import type { PixelAnnotation } from "./geometry.js";

/** Provenance held by canonical evidence descriptors; file registration belongs exclusively to RunWorkspace. */
export type EvidenceProvenance = {
  evidenceId: string;
  runId: string;
  attemptId: string;
  testcaseId?: string;
  bugId?: string;
  captureType: "screenshot" | "trace" | "console" | "network" | "log";
  dpr: number;
  scroll: { x: number; y: number };
  clip: { x: number; y: number; width: number; height: number };
  url: string;
  viewport: { width: number; height: number };
  browser: string;
  build: string;
  capturedAt: string;
  dimensions?: { width: number; height: number };
  cssBoxes?: readonly { x: number; y: number; width: number; height: number }[];
  normalizedPixelBoxes?: readonly PixelAnnotation[];
  locator?: string;
  annotationLabels?: readonly string[];
};

export function evidenceFilename(evidenceId: string, suffix: "sanitized-raw" | "annotated"): string { return `${evidenceId}-${suffix}.png`; }
