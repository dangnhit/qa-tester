import type { TestResource } from "./resources.js";

export type CleanupResourceResult = Readonly<TestResource & { status: "cleaned" | "failed"; message?: string }>;
export type CleanupResourcesResult = Readonly<{ resources: readonly CleanupResourceResult[] }>;

/** Cleanup is reverse dependency order. "already absent" is a successful idempotent cleanup. */
export async function cleanupResources(input: Readonly<{
  sourceRunId: string;
  resources: readonly TestResource[];
  execute: (resource: TestResource) => Promise<Readonly<{ status: "deleted" | "already-absent" }>>;
}>): Promise<CleanupResourcesResult> {
  if (input.resources.some((resource) => resource.ownerRunId !== input.sourceRunId)) throw new Error("Cleanup may operate only on resources with matching ownerRunId");
  const resources: CleanupResourceResult[] = [];
  for (const resource of [...input.resources].reverse()) {
    try {
      await input.execute(resource);
      resources.push({ ...resource, status: "cleaned" });
    } catch (error: unknown) {
      resources.push({ ...resource, status: "failed", message: error instanceof Error ? error.message : "cleanup failed" });
    }
  }
  return { resources };
}
