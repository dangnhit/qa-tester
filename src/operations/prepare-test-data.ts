import type { RunWorkspace } from "../core/run-workspace.js";
import type { QaConfig } from "../config/load-config.js";
import { withResolvedSecrets } from "../config/secret-resolver.js";
import { TestDataHookRegistry } from "../test-data/hooks.js";

export type TestDataManifest = Readonly<{ artifactType: "test-data-manifest"; schemaVersion: "1.0.0"; producerVersion: string; runId: string; resources: readonly { id: string; ownerRunId: string; cleanupAction: string }[] }>;

export async function prepareTestData(input: Readonly<{ workspace: RunWorkspace; hooks: TestDataHookRegistry; hookIds: readonly string[]; config?: Pick<QaConfig, "snapshot">; secretEnvironment?: Readonly<Record<string, string | undefined>> }>): Promise<TestDataManifest> {
  const registered = await input.workspace.readRegisteredArtifacts();
  const environment = registered.find((artifact) => artifact.record.type === "environment-profile")?.value;
  if (environment?.classification === "production") throw new Error("Production test-data provisioning is denied");
  if (new Set(input.hookIds).size !== input.hookIds.length) throw new Error("Test-data preparation rejects repeated hook IDs");
  return withResolvedSecrets(input.config?.snapshot ?? {}, input.secretEnvironment ?? process.env, async ({ value, scrub }) => {
    const resources = [] as { id: string; ownerRunId: string; cleanupAction: string }[];
    const operationValue = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    for (const hookId of input.hookIds) resources.push(...await input.hooks.executeTrusted(hookId, input.workspace.runId, operationValue));
    if (new Set(resources.map((resource) => resource.id)).size !== resources.length) throw new Error("Test-data preparation rejects duplicate resource IDs across hooks");
    const manifest = scrub<TestDataManifest>({ artifactType: "test-data-manifest", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: input.workspace.runId, resources });
    await input.workspace.registerArtifactValue({ type: "test-data-manifest", value: manifest, relationships: [], provenance: "runtime" });
    return manifest;
  });
}
