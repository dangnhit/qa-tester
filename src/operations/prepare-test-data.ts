import type { RunWorkspace } from "../core/run-workspace.js";
import { TestDataHookRegistry } from "../test-data/hooks.js";

export type TestDataManifest = Readonly<{ artifactType: "test-data-manifest"; schemaVersion: "1.0.0"; producerVersion: string; runId: string; resources: readonly { id: string; ownerRunId: string; cleanupAction: string }[] }>;

export async function prepareTestData(input: Readonly<{ workspace: RunWorkspace; hooks: TestDataHookRegistry; hookIds: readonly string[] }>): Promise<TestDataManifest> {
  const registered = await input.workspace.readRegisteredArtifacts();
  const environment = registered.find((artifact) => artifact.record.type === "environment-profile")?.value;
  if (environment?.classification === "production") throw new Error("Production test-data provisioning is denied");
  if (new Set(input.hookIds).size !== input.hookIds.length) throw new Error("Test-data preparation rejects repeated hook IDs");
  const resources = [] as { id: string; ownerRunId: string; cleanupAction: string }[];
  for (const hookId of input.hookIds) resources.push(...await input.hooks.execute({ hookId, ownerRunId: input.workspace.runId }));
  if (new Set(resources.map((resource) => resource.id)).size !== resources.length) throw new Error("Test-data preparation rejects duplicate resource IDs across hooks");
  const manifest: TestDataManifest = { artifactType: "test-data-manifest", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: input.workspace.runId, resources };
  await input.workspace.registerArtifactValue({ type: "test-data-manifest", value: manifest, relationships: [], provenance: "runtime" });
  return manifest;
}
