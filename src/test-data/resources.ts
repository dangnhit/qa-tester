export type TestResource = Readonly<{ id: string; ownerRunId: string; cleanupAction: string }>;

export function ownedResources(ownerRunId: string, resources: readonly { id: string; cleanupAction: string }[]): readonly TestResource[] {
  if (!ownerRunId || resources.some((resource) => !resource.id || !resource.cleanupAction)) throw new Error("Test resources require explicit IDs and cleanup ownership");
  const ids = new Set<string>();
  return Object.freeze(resources.map((resource) => {
    if (ids.has(resource.id)) throw new Error(`Test resource ${resource.id} is duplicated`);
    ids.add(resource.id);
    return Object.freeze({ id: resource.id, ownerRunId, cleanupAction: resource.cleanupAction });
  }));
}
