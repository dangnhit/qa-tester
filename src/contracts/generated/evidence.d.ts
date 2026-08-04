/* This file is generated from shared/schemas. Do not edit manually. */

export interface EvidenceItem {
  artifactType: "evidence";
  schemaVersion: "4.0.0";
  producerVersion: string;
  evidenceId: string;
  runId: string;
  subject:
    | {
        kind: "attempt";
        attemptId: string;
        testCaseId: string;
        testCaseRevisionId: string;
        testCaseInstanceId: string;
      }
    | {
        kind: "observed-execution";
        executionId: string;
      };
  kind: "screenshot" | "trace" | "console" | "network" | "log" | "runner-report" | "evidence-gap";
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
  telemetryFindings?: {
    kind: "console" | "network";
    level: string;
    message: string;
  }[];
  derivation?: {
    sourceEvidenceArtifactId: string;
    sourceEvidenceSha256: string;
    sourceBinaryArtifactId: string;
    sourceRawSha256: string;
  };
  provenance:
    | {
        captureType: "screenshot";
        dimensions: Viewport;
        dpr: number;
        scroll: Point;
        clip: Box;
        cssBoxes?: Box[];
        pixelBoxes?: Box[];
        locator?: string;
        annotationLabels?: string[];
        url: string;
        viewport: Viewport;
        browser: string;
        build: string;
        capturedAt: string;
        testcaseId?: string;
        bugId?: string;
      }
    | {
        captureType: "trace" | "console" | "network" | "log";
        url: string;
        viewport?: Viewport;
        browser: string;
        build: string;
        capturedAt: string;
        testcaseId?: string;
        bugId?: string;
      }
    | {
        captureType: "runner-report";
        /**
         * The external runner the runtime spawned and observed, e.g. "playwright".
         */
        runner: string;
        /**
         * The runner's own reported version, so the report's shape is auditable against the tool that wrote it.
         */
        runnerVersion: string;
        /**
         * The process exit code the runtime observed. An integer, including 0 — a fully passing observed execution is still evidenceable.
         */
        exitCode: number;
        capturedAt: string;
      };
}
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
