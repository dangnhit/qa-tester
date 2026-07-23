import { RunWorkspace } from "../core/run-workspace.js";
import { cleanupResources, type CleanupResourcesResult } from "../test-data/cleanup.js";
import type { TestResource } from "../test-data/resources.js";

export type CleanupRunResult = Readonly<{ cleanupRunId: string; sourceRunId: string; resources: CleanupResourcesResult["resources"] }>;

/** Creates a new linked maintenance run; source manifests are read-only evidence and are never edited. */
export async function executeCleanupRun(input: Readonly<{
  root: string;
  sourceRunId: string;
  execute: (resource: TestResource) => Promise<Readonly<{ status: "deleted" | "already-absent" }>>;
}>): Promise<CleanupRunResult> {
  const source = await RunWorkspace.open(input.root, input.sourceRunId);
  try {
    const artifacts = await source.readRegisteredArtifacts();
    const environment = artifacts.find((artifact) => artifact.record.type === "environment-profile");
    const data = artifacts.find((artifact) => artifact.record.type === "test-data-manifest");
    if (!environment || !data || !Array.isArray(data.value.resources)) throw new Error("Source run has no canonical test-data manifest");
    if (environment.value.classification === "production") throw new Error("Production cleanup is denied");
    const cleanup = await RunWorkspace.create({ root: input.root, mode: "cleanup", environmentProfile: environment.value, linkedRunId: input.sourceRunId });
    try {
      const resources = data.value.resources as TestResource[];
      const outcome = await cleanupResources({ sourceRunId: input.sourceRunId, resources, execute: input.execute });
      const value = { artifactType: "cleanup-run", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: cleanup.runId, sourceRunId: input.sourceRunId, sourceTestDataManifestArtifactId: data.record.id, resources: outcome.resources };
      await cleanup.registerArtifactValue({ type: "cleanup-run", value, relationships: [], provenance: "runtime" });
      await cleanup.finalize("cleanup");
      return { cleanupRunId: cleanup.runId, sourceRunId: input.sourceRunId, resources: outcome.resources };
    } finally { await cleanup.close(); }
  } finally { await source.close(); }
}
