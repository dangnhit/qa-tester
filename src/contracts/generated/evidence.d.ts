/* This file is generated from shared/schemas. Do not edit manually. */

export type EvidenceItem = {
  [k: string]: unknown | undefined;
} & {
  artifactType: "evidence";
  schemaVersion: "1.0.0";
  producerVersion: string;
  evidenceId: string;
  runId: string;
  attemptId: string;
  testCaseId?: string;
  testCaseRevisionId?: string;
  testCaseInstanceId?: string;
  kind: "screenshot" | "trace" | "console" | "network" | "log" | "evidence-gap";
  capturedAt: string;
  sha256: string;
  relativePath: string;
  mediaType: string;
  /**
   * @minItems 1
   */
  binaryArtifactIds: [string, ...string[]];
  /**
   * @minItems 1
   */
  binaryArtifacts: [
    {
      id: string;
      relativePath: string;
      sha256: string;
      mediaType: string;
    },
    ...{
      id: string;
      relativePath: string;
      sha256: string;
      mediaType: string;
    }[]
  ];
  pendingAttempt?: boolean;
  telemetryFindings?: {
    kind: "console" | "network";
    level: string;
    message: string;
  }[];
  provenance: {
    captureType: "screenshot" | "trace" | "console" | "network" | "log";
    dimensions: Viewport;
    dpr: number;
    scroll: Point;
    clip: Box;
    cssBoxes?: Box[];
    pixelBoxes?: Box[];
    locator?: string;
    url: string;
    viewport: Viewport;
    browser: string;
    build: string;
    capturedAt: string;
    testcaseId?: string;
    bugId?: string;
  };
};

export interface Viewport {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
