import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../src/core/checksum.js";
import type { ArtifactProfileName } from "../../src/core/artifact-profiles.js";
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

function metadata(workspace: RunWorkspace, overrides: Record<string, unknown> = {}) {
  return {
    artifactType: "run-metadata",
    schemaVersion: "1.0.0",
    producerVersion: "1.0.0",
    runId: workspace.runId,
    status: "CREATED",
    createdAt: "2026-07-23T12:34:56.000Z",
    mode: workspace.mode,
    environmentProfileId: environmentProfile.environmentProfileId,
    ...overrides,
  };
}

function testCase(id: string) {
  return {
    artifactType: "test-case",
    schemaVersion: "1.0.0",
    producerVersion: "1.0.0",
    testCaseId: id,
    revisionId: `REV-${id}`,
    title: `Test ${id}`,
    steps: [{ id: "step-1", action: "navigate", sideEffect: "none" }],
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

  it("rejects symlinked workspace and inputs directories before reads or writes escape", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const sourcePath = join(directory, "draft.json");
    await writeFile(sourcePath, JSON.stringify(metadata(workspace)));
    const outsideInputs = await mkdtemp(join(tmpdir(), "qa-skills-outside-inputs-"));
    roots.push(outsideInputs);
    await rm(join(workspace.path, "inputs"), { recursive: true });
    await symlink(outsideInputs, join(workspace.path, "inputs"));
    await expect(workspace.registerArtifact({ type: "run-metadata", sourcePath, relationships: [] })).rejects.toThrow(/symlink|escape/i);
    expect(await readdir(outsideInputs)).toEqual([]);

    await workspace.close();
    const movedWorkspace = await mkdtemp(join(tmpdir(), "qa-skills-outside-run-"));
    roots.push(movedWorkspace);
    await rm(movedWorkspace, { recursive: true });
    await rename(workspace.path, movedWorkspace);
    await symlink(movedWorkspace, workspace.path);
    await expect(RunWorkspace.open(directory, workspace.runId)).rejects.toThrow(/symlink|escape/i);
  });

  it("registers the environment profile in the manifest and detects profile tampering", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as { artifacts: { type: string; relativePath: string; sha256: string; provenance: string }[] };
    const profile = manifest.artifacts.find((artifact) => artifact.type === "environment-profile");

    expect(profile).toMatchObject({ provenance: "runtime" });
    if (!profile) throw new Error("Expected environment profile registration");
    expect(await sha256(join(workspace.path, profile.relativePath))).toBe(profile.sha256);
    await writeFile(join(workspace.path, profile.relativePath), "tampered");
    expect((await workspace.validate("plan")).diagnostics.map((diagnostic) => diagnostic.code)).toContain("CHECKSUM_MISMATCH");
  });

  it("refuses a second live workspace lock and resumes after the first workspace closes", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    await expect(RunWorkspace.open(directory, workspace.runId)).rejects.toThrow(/live lock/i);
    await workspace.close();
    const resumed = await RunWorkspace.open(directory, workspace.runId);
    await resumed.close();
  });

  it("invalidates a closed instance before handing the lock to a reopened workspace", async () => {
    const directory = await root();
    const stale = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const sourcePath = join(directory, "draft.json");
    await writeFile(sourcePath, JSON.stringify(metadata(stale)));
    await stale.close();
    const current = await RunWorkspace.open(directory, stale.runId);

    await expect(stale.registerArtifact({ type: "run-metadata", sourcePath, relationships: [] })).rejects.toThrow(/closed/i);
    await expect(stale.transition("RUNNING")).rejects.toThrow(/closed/i);
    await expect(current.transition("RUNNING")).resolves.toBeUndefined();
    await current.close();
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

  it("only permits public start and reserves finalizing and terminal transitions for finalize", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });

    await expect(workspace.transition("FINALIZING")).rejects.toThrow(/transition/i);
    await expect(workspace.transition("ABORTED")).rejects.toThrow(/transition/i);
    await expect(workspace.transition("COMPLETED")).rejects.toThrow(/transition/i);
    await workspace.transition("RUNNING");
    await expect(workspace.transition("BLOCKED")).rejects.toThrow(/transition/i);
    await expect(workspace.transition("ABORTED")).rejects.toThrow(/transition/i);
    await expect(workspace.transition("FINALIZING")).rejects.toThrow(/finalize|transition/i);
    await expect(workspace.finalize("plan")).resolves.toMatchObject({ valid: true });
    await expect(workspace.transition("RUNNING")).rejects.toThrow(/terminal|transition/i);
    await expect(workspace.registerArtifact({ type: "run-metadata", sourcePath: join(directory, "missing.json"), relationships: [] })).rejects.toThrow(/terminal/i);
  });

  it("finalizes from CREATED or RUNNING without repeating the RUNNING transition", async () => {
    const directory = await root();
    const createdWorkspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    await expect(createdWorkspace.finalize("plan")).resolves.toMatchObject({ valid: true });

    const runningWorkspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    await runningWorkspace.transition("RUNNING");
    await expect(runningWorkspace.finalize("plan")).resolves.toMatchObject({ valid: true });
  });

  it("persists the exact audited profile name and version used for finalization", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "full", environmentProfile });

    await workspace.finalize("plan");
    expect(JSON.parse(await readFile(join(workspace.path, "run-metadata.json"), "utf8"))).toMatchObject({
      status: "COMPLETED",
      finalizedProfile: { name: "plan", version: "1.0.0" },
    });
  });

  it("rejects an unknown profile before changing lifecycle state", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });

    await expect(workspace.finalize("invented" as ArtifactProfileName)).rejects.toThrow(/profile/i);
    expect(JSON.parse(await readFile(join(workspace.path, "run-metadata.json"), "utf8"))).toMatchObject({ status: "CREATED" });
  });

  it("requires structured evidence gaps and canonicalizes them atomically", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const invalidPath = join(directory, "arbitrary.txt");
    await writeFile(invalidPath, "not an evidence gap");
    await expect(workspace.registerArtifact({ type: "evidence-gap", sourcePath: invalidPath, relationships: [] })).rejects.toThrow(/evidence gap|contract|invalid/i);

    const gapPath = join(directory, "gap.yaml");
    await writeFile(gapPath, [
      "artifactType: evidence-gap",
      "schemaVersion: 1.0.0",
      "producerVersion: 1.0.0",
      `runId: ${workspace.runId}`,
      "reason: Redaction could not safely complete",
      "affectedClaim: The checkout request completed successfully",
      "",
    ].join("\n"));
    const registered = await workspace.registerArtifact({ type: "evidence-gap", sourcePath: gapPath, relationships: [] });
    expect(JSON.parse(await readFile(registered.absolutePath, "utf8"))).toMatchObject({ artifactType: "evidence-gap", runId: workspace.runId });
    expect((await readdir(join(workspace.path, "inputs"))).some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("rejects evidence gaps without an affected claim", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const gapPath = join(directory, "gap.json");
    await writeFile(gapPath, JSON.stringify({
      artifactType: "evidence-gap",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      runId: workspace.runId,
      reason: "The upstream system redacted the response.",
    }));

    await expect(workspace.registerArtifact({ type: "evidence-gap", sourcePath: gapPath, relationships: [] })).rejects.toThrow(/contract|invalid/i);
  });

  it("binds run IDs, environment profile IDs, and relationships to this workspace", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const foreignRun = join(directory, "foreign-run.json");
    await writeFile(foreignRun, JSON.stringify(metadata(workspace, { runId: "20260723T123456Z-a1b2c3" })));
    await expect(workspace.registerArtifact({ type: "run-metadata", sourcePath: foreignRun, relationships: [] })).rejects.toThrow(/run.*workspace|binding/i);

    const foreignEnvironment = join(directory, "foreign-environment.json");
    await writeFile(foreignEnvironment, JSON.stringify(metadata(workspace, { environmentProfileId: "env-foreign" })));
    await expect(workspace.registerArtifact({ type: "run-metadata", sourcePath: foreignEnvironment, relationships: [] })).rejects.toThrow(/environment.*workspace|binding/i);

    const firstPath = join(directory, "related-case.json");
    await writeFile(firstPath, JSON.stringify(testCase("TC-RELATED")));
    const first = await workspace.registerArtifact({ type: "test-case", sourcePath: firstPath, relationships: [] });
    const secondPath = join(directory, "dependent-case.json");
    await writeFile(secondPath, JSON.stringify(testCase("TC-DEPENDENT")));
    await expect(workspace.registerArtifact({ type: "test-case", sourcePath: secondPath, relationships: [first.id] })).resolves.toMatchObject({ relationships: [first.id] });

    const unknownRelationshipPath = join(directory, "unknown-related-case.json");
    await writeFile(unknownRelationshipPath, JSON.stringify(testCase("TC-UNKNOWN")));
    await expect(workspace.registerArtifact({ type: "test-case", sourcePath: unknownRelationshipPath, relationships: ["unknown-artifact"] })).rejects.toThrow(/relationship|binding/i);
  });

  it("rejects a conflicting second authoritative environment profile", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const sourcePath = join(directory, "other-environment.json");
    await writeFile(sourcePath, JSON.stringify({
      ...environmentProfile,
      environmentProfileId: "env-other",
      name: "Other",
    }));

    await expect(workspace.registerArtifact({ type: "environment-profile", sourcePath, relationships: [] })).rejects.toThrow(/environment.*profile|authoritative|binding/i);
  });

  it("allows distinct artifacts of the same type while rejecting an identical canonical artifact", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const firstPath = join(directory, "first-case.json");
    const secondPath = join(directory, "second-case.json");
    await writeFile(firstPath, JSON.stringify(testCase("TC-1")));
    await writeFile(secondPath, JSON.stringify(testCase("TC-2")));

    await expect(workspace.registerArtifact({ type: "test-case", sourcePath: firstPath, relationships: [] })).resolves.toMatchObject({ type: "test-case" });
    await expect(workspace.registerArtifact({ type: "test-case", sourcePath: secondPath, relationships: [] })).resolves.toMatchObject({ type: "test-case" });
    await expect(workspace.registerArtifact({ type: "test-case", sourcePath: firstPath, relationships: [] })).rejects.toThrow(/duplicate|immutable/i);
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

  it("persists an atomic manifest with the authoritative environment profile", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as { artifacts: unknown[] };
    expect(manifest.artifacts).toEqual([
      expect.objectContaining({ type: "environment-profile", provenance: "runtime" }),
    ]);
  });
});
