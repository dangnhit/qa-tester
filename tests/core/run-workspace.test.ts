import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../src/core/checksum.js";
import type { ArtifactType } from "../../src/contracts/types.js";
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

function testResult(workspace: RunWorkspace, testCaseId: string, attemptId = "ATTEMPT-1") {
  return {
    artifactType: "test-result",
    schemaVersion: "1.0.0",
    producerVersion: "1.0.0",
    attemptId,
    runId: workspace.runId,
    testCaseId,
    status: "PASSED",
    failureClassification: "NONE",
    startedAt: "2026-07-23T12:34:56.000Z",
    finishedAt: "2026-07-23T12:35:56.000Z",
  };
}

async function registerDocument(workspace: RunWorkspace, type: ArtifactType, name: string, value: unknown) {
  const sourcePath = join(workspace.root, name);
  await writeFile(sourcePath, JSON.stringify(value));
  return workspace.registerArtifact({ type, sourcePath, relationships: [] });
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

  it("marks the instance closed before lock release can yield", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });

    const closing = workspace.close();
    await expect(workspace.transition("RUNNING")).rejects.toThrow(/closed/i);
    await expect(closing).resolves.toBeUndefined();
  });

  it("rejects persisted metadata run ID tampering when opening", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    await workspace.close();
    await writeFile(join(workspace.path, "run-metadata.json"), JSON.stringify(metadata(workspace, {
      runId: "20260723T123456Z-a1b2c3",
    })));

    await expect(RunWorkspace.open(directory, workspace.runId)).rejects.toThrow(/run.*workspace|binding/i);
  });

  it("rejects persisted manifest run ID tampering on open and validate", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const manifestPath = join(workspace.path, "artifact-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, JSON.stringify({ ...manifest, runId: "20260723T123456Z-a1b2c3" }));

    await expect(workspace.validate()).rejects.toThrow(/manifest.*run|binding/i);
    await workspace.close();
    await expect(RunWorkspace.open(directory, workspace.runId)).rejects.toThrow(/manifest.*run|binding/i);
  });

  it("binds persisted environment metadata to the authoritative registered profile", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    await workspace.close();
    await writeFile(join(workspace.path, "run-metadata.json"), JSON.stringify(metadata(workspace, {
      environmentProfileId: "env-foreign",
    })));

    await expect(RunWorkspace.open(directory, workspace.runId)).rejects.toThrow(/environment.*profile|binding/i);
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
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });

    await workspace.finalize("plan");
    expect(JSON.parse(await readFile(join(workspace.path, "run-metadata.json"), "utf8"))).toMatchObject({
      status: "COMPLETED",
      finalizedProfile: { name: "plan", version: "1.0.0" },
    });
  });

  it("rejects finalization with a weaker profile than the run mode", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "full", environmentProfile });

    await expect(workspace.finalize("plan")).rejects.toThrow(/mode|profile|downgrade/i);
    expect(JSON.parse(await readFile(join(workspace.path, "run-metadata.json"), "utf8"))).toMatchObject({
      status: "CREATED",
      mode: "full",
    });
  });

  it("rejects an unknown profile before changing lifecycle state", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });

    await expect(workspace.finalize("invented" as ArtifactProfileName)).rejects.toThrow(/profile/i);
    expect(JSON.parse(await readFile(join(workspace.path, "run-metadata.json"), "utf8"))).toMatchObject({ status: "CREATED" });
  });

  it("remains retryable when finalization precondition validation throws", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const manifestPath = join(workspace.path, "artifact-manifest.json");
    const validManifest = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, "{");

    await expect(workspace.finalize()).rejects.toThrow();
    expect(JSON.parse(await readFile(join(workspace.path, "run-metadata.json"), "utf8"))).toMatchObject({
      status: "RUNNING",
    });

    await writeFile(manifestPath, validManifest);
    await expect(workspace.finalize()).resolves.toMatchObject({ valid: true });
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

  it("validates test result, attempt, and step references against registered artifacts", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile });

    await expect(registerDocument(workspace, "test-result", "missing-case-result.json", testResult(workspace, "TC-MISSING"))).rejects.toThrow(/test.?case|reference|binding/i);
    await registerDocument(workspace, "test-case", "case.json", testCase("TC-1"));
    await registerDocument(workspace, "test-result", "result.json", testResult(workspace, "TC-1"));

    const stepResult = {
      artifactType: "test-step-result",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      attemptId: "ATTEMPT-1",
      stepId: "step-1",
      status: "PASSED",
      durationMs: 1,
    };
    await expect(registerDocument(workspace, "test-step-result", "foreign-attempt-step.json", { ...stepResult, attemptId: "ATTEMPT-MISSING" })).rejects.toThrow(/attempt|reference|binding/i);
    await expect(registerDocument(workspace, "test-step-result", "foreign-step.json", { ...stepResult, stepId: "step-missing" })).rejects.toThrow(/step|reference|binding/i);
    await expect(registerDocument(workspace, "test-step-result", "step.json", stepResult)).resolves.toMatchObject({ type: "test-step-result" });
  });

  it("validates evidence and bug references by expected type and attempt", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "full", environmentProfile });
    await registerDocument(workspace, "test-case", "case.json", testCase("TC-1"));
    await registerDocument(workspace, "test-result", "result.json", testResult(workspace, "TC-1"));

    const evidence = {
      artifactType: "evidence",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      evidenceId: "01K0ABCDEFGHJKMNPQRSTVWXYZ",
      runId: workspace.runId,
      attemptId: "ATTEMPT-1",
      kind: "log",
      capturedAt: "2026-07-23T12:34:56.000Z",
      sha256: "a".repeat(64),
      relativePath: "evidence/log.json",
    };
    await expect(registerDocument(workspace, "evidence", "foreign-evidence.json", { ...evidence, attemptId: "ATTEMPT-MISSING" })).rejects.toThrow(/attempt|reference|binding/i);
    await registerDocument(workspace, "evidence", "evidence.json", evidence);

    const bug = {
      artifactType: "bug-report",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      bugId: "BUG-LOGIN-001",
      runId: workspace.runId,
      attemptId: "ATTEMPT-1",
      triageStatus: "NEEDS_TRIAGE",
      expected: "Login succeeds",
      actual: "Login fails",
      evidenceIds: [evidence.evidenceId],
    };
    await expect(registerDocument(workspace, "bug-report", "foreign-bug-attempt.json", { ...bug, attemptId: "ATTEMPT-MISSING" })).rejects.toThrow(/attempt|reference|binding/i);
    await expect(registerDocument(workspace, "bug-report", "foreign-bug-evidence.json", { ...bug, evidenceIds: ["01K0ABCDEFGHJKMNPQRSTVWXY0"] })).rejects.toThrow(/evidence|reference|binding/i);
    await expect(registerDocument(workspace, "bug-report", "bug.json", bug)).resolves.toMatchObject({ type: "bug-report" });
  });

  it("binds test-data resource ownership to the workspace run", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "cleanup", environmentProfile });
    const manifest = {
      artifactType: "test-data-manifest",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      runId: workspace.runId,
      resources: [{ id: "resource-1", ownerRunId: "foreign-run", cleanupAction: "delete" }],
    };

    await expect(registerDocument(workspace, "test-data-manifest", "foreign-owner.json", manifest)).rejects.toThrow(/owner|run|binding/i);
    await expect(registerDocument(workspace, "test-data-manifest", "owned.json", {
      ...manifest,
      resources: [{ ...manifest.resources[0], ownerRunId: workspace.runId }],
    })).resolves.toMatchObject({ type: "test-data-manifest" });
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
