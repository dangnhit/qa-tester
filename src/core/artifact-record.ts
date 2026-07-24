import type { ArtifactType, RunStatus } from "../contracts/types.js";

export type ArtifactRecord = {
  id: string;
  type: ArtifactType;
  relativePath: string;
  sha256: string;
  mediaType?: string;
  captureType?: "screenshot" | "trace" | "console" | "network" | "log";
  dimensions?: { width: number; height: number };
  provenance: string;
  relationships: string[];
};

/**
 * The persisted artifact-manifest shape. Kept in this neutral, dependency-light core module (rather
 * than in `run-workspace.ts` or `semantic-rules.ts`) so BOTH can import it without a type cycle:
 * `run-workspace.ts` no longer depends on `semantic-rules.ts` for this shape, and `semantic-rules.ts`
 * stays free of any dependency on the `RunWorkspace` class.
 */
export type Manifest = {
  artifactType: "artifact-manifest";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  artifacts: ArtifactRecord[];
};

/** Run statuses that mark a workspace immutable/terminal. Shared by `run-workspace.ts` (lifecycle
 *  gating) and `semantic-rules.ts` (cleanup-run source-run immutability). */
export const terminalStatuses = new Set<RunStatus>(["COMPLETED", "COMPLETED_WITH_FAILURES", "BLOCKED", "ABORTED"]);
