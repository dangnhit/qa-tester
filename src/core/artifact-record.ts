import type { ArtifactType, RunStatus } from "../contracts/types.js";
import { artifactProfileVersion, type ArtifactProfileName } from "./artifact-profiles.js";
import { isRecord } from "./values.js";

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

/** The persisted run-metadata shape. Neutral home shared by `run-workspace.ts` (lifecycle/write path)
 *  and `inspect-workspace-state.ts` (read/validate path) so the extracted read scanner imports it
 *  without a back-edge onto `run-workspace.ts`. */
export type WorkspaceMetadata = {
  artifactType: "run-metadata";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  status: RunStatus;
  createdAt: string;
  mode: ArtifactProfileName;
  environmentProfileId: string;
  finalizedProfile?: { name: ArtifactProfileName; version: typeof artifactProfileVersion };
  linkedRunId?: string;
};

/** A single read-path validation finding. Its neutral home lets `inspect-workspace-state.ts` produce
 *  it and `run-workspace.ts` re-export it (preserving the public `WorkspaceDiagnostic` API) with no cycle. */
export type WorkspaceDiagnostic = { code: string; message: string; relativePath?: string };

/** Run statuses that mark a workspace immutable/terminal. Shared by `run-workspace.ts` (lifecycle
 *  gating) and `semantic-rules.ts` (cleanup-run source-run immutability). */
export const terminalStatuses = new Set<RunStatus>(["COMPLETED", "COMPLETED_WITH_FAILURES", "BLOCKED", "ABORTED"]);

function matchingDimensions(value: unknown, dimensions: { width: number; height: number }): boolean {
  return isRecord(value) && value.width === dimensions.width && value.height === dimensions.height;
}

/** Shared descriptor↔primary-binary equality. Used by the WRITE path (`registerEvidenceBundle`) and the
 *  READ path (`inspectWorkspaceState`), so it lives in this neutral module both import. */
export function matchesEvidencePrimary(value: Record<string, unknown>, primary: ArtifactRecord): boolean {
  const provenance = value.provenance;
  return value.sha256 === primary.sha256
    && value.relativePath === primary.relativePath
    && value.mediaType === primary.mediaType
    && value.kind === primary.captureType
    && isRecord(provenance)
    && provenance.captureType === primary.captureType
    && (primary.dimensions === undefined || matchingDimensions(provenance.dimensions, primary.dimensions));
}
