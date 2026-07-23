import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../src/core/checksum.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "qa-skills-workspace-"));
  roots.push(path);
  return path;
}

const environmentProfile = {
  artifactType: "environment-profile",
  schemaVersion: "1.0.0",
  producerVersion: "1.0.0",
  environmentProfileId: "env-test",
  name: "Test",
  classification: "test",
  baseUrl: "https://test.example.test",
  productionReadOnly: false,
} as const;

function metadata(workspace: RunWorkspace) {
  return {
    artifactType: "run-metadata",
    schemaVersion: "1.0.0",
    producerVersion: "1.0.0",
    runId: workspace.runId,
    status: "CREATED",
    createdAt: "2026-07-23T12:34:56.000Z",
    mode: workspace.mode,
    environmentProfileId: environmentProfile.environmentProfileId,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("RunWorkspace", () => {
  it("copies validated artifacts into immutable inputs and records their checksum", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const sourcePath = join(directory, "draft.json");
    await writeFile(sourcePath, JSON.stringify(metadata(workspace)));

    const input = { type: "run-metadata" as const, sourcePath, relationships: [] };
    const registered = await workspace.registerArtifact(input);

    expect(registered.relativePath.startsWith("inputs/")).toBe(true);
    expect(await sha256(registered.absolutePath)).toBe(registered.sha256);
    await expect(workspace.registerArtifact(input)).rejects.toThrow(/immutable|duplicate/i);
  });

  it("rejects path traversal and symlink escapes", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    await expect(workspace.resolve("../outside.json")).rejects.toThrow(/traversal|escape/i);

    const outside = join(directory, "outside.json");
    await writeFile(outside, JSON.stringify(metadata(workspace)));
    const link = join(workspace.path, "linked.json");
    await symlink(outside, link);
    await expect(workspace.registerArtifact({ type: "run-metadata", sourcePath: link, relationships: [] })).rejects.toThrow(/symlink|escape/i);
  });

  it("refuses a second live workspace lock and resumes after the first workspace closes", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    await expect(RunWorkspace.open(directory, workspace.runId)).rejects.toThrow(/live lock/i);
    await workspace.close();
    const resumed = await RunWorkspace.open(directory, workspace.runId);
    await resumed.close();
  });

  it("canonicalizes YAML Agent Drafts into registered JSON artifacts", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const sourcePath = join(directory, "draft.yaml");
    await writeFile(sourcePath, [
      "artifactType: run-metadata",
      "schemaVersion: 1.0.0",
      "producerVersion: 1.0.0",
      `runId: ${workspace.runId}`,
      "status: CREATED",
      "createdAt: 2026-07-23T12:34:56.000Z",
      "mode: plan",
      "environmentProfileId: env-test",
      "",
    ].join("\n"));

    const registered = await workspace.registerArtifact({ type: "run-metadata", sourcePath, relationships: [] });
    expect(JSON.parse(await readFile(registered.absolutePath, "utf8"))).toMatchObject({ artifactType: "run-metadata", runId: workspace.runId });
  });

  it("only permits the declared lifecycle and rejects writes after a terminal outcome", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });

    await expect(workspace.transition("FINALIZING")).rejects.toThrow(/transition/i);
    await workspace.transition("RUNNING");
    await workspace.transition("FINALIZING");
    await workspace.transition("COMPLETED");
    await expect(workspace.transition("RUNNING")).rejects.toThrow(/terminal|transition/i);
    await expect(workspace.registerArtifact({ type: "run-metadata", sourcePath: join(directory, "missing.json"), relationships: [] })).rejects.toThrow(/terminal/i);
  });

  it("detects missing registered files, checksum mismatches, and unregistered orphan files", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const sourcePath = join(directory, "draft.json");
    await writeFile(sourcePath, JSON.stringify(metadata(workspace)));
    const registered = await workspace.registerArtifact({ type: "run-metadata", sourcePath, relationships: [] });
    await writeFile(registered.absolutePath, "changed");
    await writeFile(join(workspace.path, "inputs", "orphan.json"), "{}");
    const result = await workspace.validate("plan");

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["CHECKSUM_MISMATCH", "ORPHAN_FILE"]),
    );
    await rm(registered.absolutePath);
    expect((await workspace.validate("plan")).diagnostics.map((diagnostic) => diagnostic.code)).toContain("MISSING_FILE");
  });

  it("persists an atomic manifest rather than partial JSON", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as { artifacts: unknown[] };
    expect(manifest.artifacts).toEqual([]);
  });
});
