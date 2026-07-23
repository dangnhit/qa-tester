/* This file is generated from shared/schemas. Do not edit manually. */

export interface EvidenceAnnotation {
  artifactType: "annotation";
  schemaVersion: "1.0.0";
  producerVersion: string;
  evidenceId: string;
  captureType: "screenshot";
  rawSha256: string;
  sourceEvidenceArtifactId: string;
  sourceEvidenceSha256: string;
  sourceBinaryArtifactId: string;
  annotations: {
    id: string;
    label?: string;
    locator?: string;
    cssBox: Box;
    pixelBox: Box;
  }[];
  provenance: {
    runId: string;
    attemptId: string;
    testcaseId?: string;
    bugId?: string;
    url: string;
    viewport: Viewport;
    browser: string;
    build: string;
    capturedAt: string;
    dimensions?: Viewport;
    dpr: number;
    scroll: Point;
    clip: Box;
  };
}
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Viewport {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}
