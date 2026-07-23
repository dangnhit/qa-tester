import { mkdtemp } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { RunWorkspace } from "../../src/core/run-workspace.js";
import { executeCleanupRun } from "../../src/operations/cleanup-run.js";
import { prepareTestData } from "../../src/operations/prepare-test-data.js";
import { TestDataHookRegistry } from "../../src/test-data/hooks.js";

const environment = (classification: "test" | "production") => ({ artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: `env-${classification}`, name: classification, classification, baseUrl: "https://example.test", productionReadOnly: classification === "production" });

describe("test-data operations", () => {
  it("registers owned resources then creates a distinct linked immutable cleanup run", async () => {
    const root = await mkdtemp("/tmp/qa-data-");
    const source = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment("test") });
    const hooks = new TestDataHookRegistry([{ id: "seed", kind: "api", fixture: "seed-user" }], { api: () => Promise.resolve([{ id: "resource-1", cleanupAction: "delete-user" }]) });
    const manifest = await prepareTestData({ workspace: source, hooks, hookIds: ["seed"] });
    await source.finalize("execute", "ABORTED");
    await source.close();

    const cleaned: string[] = [];
    const result = await executeCleanupRun({ root, sourceRunId: manifest.runId, execute: (resource) => { cleaned.push(resource.id); return Promise.resolve({ status: "already-absent" as const }); } });

    expect(cleaned).toEqual(["resource-1"]);
    expect(result.cleanupRunId).not.toBe(manifest.runId);
    const cleanup = await RunWorkspace.open(root, result.cleanupRunId);
    expect((await cleanup.readRegisteredArtifacts()).some((artifact) => artifact.record.type === "cleanup-run")).toBe(true);
    await cleanup.close();
  });

  it("denies production provisioning before a hook can create resources", async () => {
    const root = await mkdtemp("/tmp/qa-data-");
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment("production") });
    const hooks = new TestDataHookRegistry([{ id: "seed", kind: "api", fixture: "seed-user" }], { api: () => Promise.resolve([{ id: "resource-1", cleanupAction: "delete-user" }]) });
    await expect(prepareTestData({ workspace, hooks, hookIds: ["seed"] })).rejects.toThrow(/production/i);
    await workspace.close();
  });
});
