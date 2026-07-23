import { describe, expect, it } from "vitest";

import { cleanupResources } from "../../src/test-data/cleanup.js";

describe("cleanupResources", () => {
  it("cleans owned resources in reverse order and records idempotent outcomes", async () => {
    const calls: string[] = [];
    const result = await cleanupResources({
      sourceRunId: "run-1",
      resources: [
        { id: "first", ownerRunId: "run-1", cleanupAction: "delete-first" },
        { id: "last", ownerRunId: "run-1", cleanupAction: "delete-last" },
      ],
      execute: (resource) => { calls.push(resource.id); return Promise.resolve({ status: "already-absent" as const }); },
    });

    expect(calls).toEqual(["last", "first"]);
    expect(result.resources.every((resource) => resource.status === "cleaned")).toBe(true);
    await expect(cleanupResources({ sourceRunId: "run-1", resources: [{ id: "foreign", ownerRunId: "run-2", cleanupAction: "delete" }], execute: () => Promise.resolve({ status: "deleted" as const }) })).rejects.toThrow(/owner/i);
  });
});
