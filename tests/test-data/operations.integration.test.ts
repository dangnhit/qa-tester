import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

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
    const sourceManifestBefore = await readFile(`${source.path}/artifact-manifest.json`, "utf8");
    await source.close();

    const cleaned: string[] = [];
    const result = await executeCleanupRun({ root, sourceRunId: manifest.runId, execute: (resource) => { cleaned.push(resource.id); return Promise.resolve({ status: "already-absent" as const }); } });

    expect(cleaned).toEqual(["resource-1"]);
    expect(result.cleanupRunId).not.toBe(manifest.runId);
    expect(await readFile(`${root}/qa-results/${manifest.runId}/artifact-manifest.json`, "utf8")).toBe(sourceManifestBefore);
    const cleanup = await RunWorkspace.open(root, result.cleanupRunId);
    expect((await cleanup.readRegisteredArtifacts()).some((artifact) => artifact.record.type === "cleanup-run")).toBe(true);
    await cleanup.close();
    const retry = await executeCleanupRun({ root, sourceRunId: manifest.runId, execute: () => Promise.resolve({ status: "already-absent" as const }) });
    expect(retry.cleanupRunId).not.toBe(result.cleanupRunId);

    const tampered = await RunWorkspace.open(root, result.cleanupRunId);
    const cleanupRecord = (await tampered.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "cleanup-run");
    expect(cleanupRecord).toBeDefined();
    const artifactPath = `${tampered.path}/${cleanupRecord?.record.relativePath ?? ""}`;
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as Record<string, unknown>;
    artifact.sourceTestDataManifestSha256 = "a".repeat(64);
    const contents = `${JSON.stringify(artifact, null, 2)}\n`;
    await writeFile(artifactPath, contents);
    const manifestPath = `${tampered.path}/artifact-manifest.json`;
    const cleanupManifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; sha256: string }[] };
    const manifestRecord = cleanupManifest.artifacts.find((record) => record.id === cleanupRecord?.record.id);
    if (manifestRecord) manifestRecord.sha256 = createHash("sha256").update(contents).digest("hex");
    await writeFile(manifestPath, `${JSON.stringify(cleanupManifest, null, 2)}\n`);
    await tampered.close();
    await expect(RunWorkspace.open(root, result.cleanupRunId)).rejects.toThrow(/checksum|provenance|binding/i);
  });

  it("rejects repeated hooks and duplicate resource IDs across ordered hooks", async () => {
    const root = await mkdtemp("/tmp/qa-data-");
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment("test") });
    const calls: string[] = [];
    const hooks = new TestDataHookRegistry([
      { id: "one", kind: "api", fixture: "one" },
      { id: "two", kind: "api", fixture: "two" },
    ], { api: (descriptor) => { calls.push(descriptor.id); return Promise.resolve([{ id: descriptor.id === "one" ? "same" : "same", cleanupAction: "delete" }]); } });
    await expect(prepareTestData({ workspace, hooks, hookIds: ["one", "one"] })).rejects.toThrow(/repeated/i);
    await expect(prepareTestData({ workspace, hooks, hookIds: ["one", "two"] })).rejects.toThrow(/duplicate/i);
    expect(calls).toEqual(["one", "two"]);
    await workspace.close();
  });

  it("denies production provisioning before a hook can create resources", async () => {
    const root = await mkdtemp("/tmp/qa-data-");
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment("production") });
    const hooks = new TestDataHookRegistry([{ id: "seed", kind: "api", fixture: "seed-user" }], { api: () => Promise.resolve([{ id: "resource-1", cleanupAction: "delete-user" }]) });
    await expect(prepareTestData({ workspace, hooks, hookIds: ["seed"] })).rejects.toThrow(/production/i);
    await workspace.close();
  });

  it("marks a linked cleanup run completed with failures while retaining reverse-order results", async () => {
    const root = await mkdtemp("/tmp/qa-data-");
    const source = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment("test") });
    const hooks = new TestDataHookRegistry([{ id: "seed", kind: "api", fixture: "seed" }], { api: () => Promise.resolve([{ id: "first", cleanupAction: "delete" }, { id: "last", cleanupAction: "delete" }]) });
    const sourceManifest = await prepareTestData({ workspace: source, hooks, hookIds: ["seed"] });
    await source.finalize("execute", "ABORTED");
    await source.close();
    const calls: string[] = [];
    const outcome = await executeCleanupRun({ root, sourceRunId: sourceManifest.runId, execute: (resource) => {
      calls.push(resource.id);
      return resource.id === "last" ? Promise.reject(new Error("delete failed")) : Promise.resolve({ status: "already-absent" as const });
    } });
    expect(calls).toEqual(["last", "first"]);
    expect(outcome.resources.map((resource) => resource.status)).toEqual(["failed", "cleaned"]);
    expect(JSON.parse(await readFile(`${root}/qa-results/${outcome.cleanupRunId}/run-metadata.json`, "utf8"))).toMatchObject({ status: "COMPLETED_WITH_FAILURES", linkedRunId: sourceManifest.runId });
  });

  it("resolves secrets only in operation memory and scrubs hook outputs and errors", async () => {
    const root = await mkdtemp("/tmp/qa-data-");
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment("test") });
    const config = { configDirectory: root, snapshot: { version: 1, headers: { Authorization: "${ENV:DISTINCT_QA_SECRET}" } } };
    const success = new TestDataHookRegistry([{ id: "seed", kind: "api", fixture: "seed" }], { api: (_descriptor, operation) => Promise.resolve([{ id: "resource", cleanupAction: `delete-${String((operation?.headers as Record<string, string>).Authorization)}` }]) });
    const manifest = await prepareTestData({ workspace, hooks: success, hookIds: ["seed"], config, secretEnvironment: { DISTINCT_QA_SECRET: "distinctive-secret-value" } });
    expect(JSON.stringify(config.snapshot)).toContain("${ENV:DISTINCT_QA_SECRET}");
    expect(JSON.stringify(manifest)).not.toContain("distinctive-secret-value");
    expect(JSON.stringify(await workspace.readRegisteredArtifacts())).not.toContain("distinctive-secret-value");
    const failure = new TestDataHookRegistry([{ id: "fail", kind: "api", fixture: "fail" }], { api: (_descriptor, operation) => Promise.reject(new Error(`failed ${String((operation?.headers as Record<string, string>).Authorization)}`)) });
    await expect(prepareTestData({ workspace, hooks: failure, hookIds: ["fail"], config, secretEnvironment: { DISTINCT_QA_SECRET: "distinctive-secret-value" } })).rejects.toThrow(/\[REDACTED\]/);
    await workspace.close();
  });
});
