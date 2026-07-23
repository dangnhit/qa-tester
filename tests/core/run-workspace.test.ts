import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256, sha256Text } from "../../src/core/checksum.js";
import type { ArtifactType } from "../../src/contracts/types.js";
import type { ArtifactProfileName } from "../../src/core/artifact-profiles.js";
import { atomicWriteFile } from "../../src/core/fs.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { createBugFingerprint, createRunScopedBugId } from "../../src/defects/fingerprint.js";

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
    instanceId: `${id}--INSTANCE-1`,
    title: `Test ${id}`,
    steps: [{ id: "step-1", action: "navigate", sideEffect: "none" }],
    coverage: {
      requirementId: "REQ-TEST", role: "member", behavior: "test behavior", browser: "chromium",
      viewport: { width: 1440, height: 900 }, accessibilityMethod: null, risk: "low", outcome: "test outcome",
    },
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
    testCaseRevisionId: `REV-${testCaseId}`,
    testCaseInstanceId: `${testCaseId}--INSTANCE-1`,
    status: "PASSED",
    failureClassification: "NONE",
    startedAt: "2026-07-23T12:34:56.000Z",
    finishedAt: "2026-07-23T12:35:56.000Z",
  };
}

async function registerEvidenceAttempt(workspace: RunWorkspace, attemptId = "ATTEMPT-EVIDENCE") {
  const testCaseRecord = await workspace.registerArtifactValue({ type: "test-case", relationships: [], value: testCase("TC-EVIDENCE") });
  return workspace.registerArtifactValue({ type: "test-result", relationships: [testCaseRecord.id], value: testResult(workspace, "TC-EVIDENCE", attemptId) });
}
async function registerDocument(workspace: RunWorkspace, type: ArtifactType, name: string, value: unknown, relationships: string[] = []) {
  const sourcePath = join(workspace.root, name);
  await writeFile(sourcePath, JSON.stringify(value));
  return workspace.registerArtifact({ type, sourcePath, relationships });
}

function failMetadataStatusOnce(status: string) {
  let failed = false;
  return {
    async writeAtomic(rootPath: string, path: string, contents: string): Promise<void> {
      const value = path.endsWith("run-metadata.json") ? JSON.parse(contents) as { status?: string } : undefined;
      if (!failed && value?.status === status) {
        failed = true;
        throw new Error(`Injected ${status} metadata write failure`);
      }
      await atomicWriteFile(rootPath, path, contents);
    },
  };
}

function failNextManifestWrite() {
  let armed = false;
  return {
    arm(): void {
      armed = true;
    },
    persistence: {
      async writeAtomic(rootPath: string, path: string, contents: string): Promise<void> {
        if (armed && path.endsWith("artifact-manifest.json")) {
          armed = false;
          throw new Error("Injected artifact manifest write failure");
        }
        await atomicWriteFile(rootPath, path, contents);
      },
    },
  };
}

function failSecondEvidenceBinaryWrite() {
  let evidenceWrites = 0;
  return {
    persistence: {
      async writeAtomic(rootPath: string, path: string, contents: string | Uint8Array): Promise<void> {
        if (path.includes("/evidence/") && contents instanceof Uint8Array && ++evidenceWrites === 2) {
          await atomicWriteFile(rootPath, path, contents);
          throw new Error("Injected late evidence binary write failure");
        }
        await atomicWriteFile(rootPath, path, contents);
      },
    },
  };
}

function screenshotDescriptor(workspace: RunWorkspace, binaries: readonly { id: string; relativePath: string; sha256: string; mediaType?: string }[], overrides: Record<string, unknown> = {}) {
  const primary = binaries[0];
  return {
    artifactType: "evidence", schemaVersion: "1.0.0", producerVersion: "0.1.0", evidenceId: "01K0ABCDEFGHJKMNPQRSTVWXYZ", runId: workspace.runId, attemptId: "ATTEMPT-EVIDENCE", testCaseId: "TC-EVIDENCE", testCaseRevisionId: "REV-TC-EVIDENCE", testCaseInstanceId: "TC-EVIDENCE--INSTANCE-1", kind: "screenshot", capturedAt: "2026-07-23T00:00:00.000Z", sha256: primary?.sha256, relativePath: primary?.relativePath, mediaType: primary?.mediaType,
    binaryArtifactIds: binaries.map((binary) => binary.id), binaryArtifacts: binaries.map((binary) => ({ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType })),
    provenance: { captureType: "screenshot", dimensions: { width: 1, height: 1 }, dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 1, height: 1 }, url: "about:blank", viewport: { width: 1, height: 1 }, browser: "chromium", build: "test", capturedAt: "2026-07-23T00:00:00.000Z" },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("RunWorkspace", () => {
  it("commits an evidence binary and descriptor together or leaves neither registered", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile });
    const attempt = await registerEvidenceAttempt(workspace);
    const bundle = await workspace.registerEvidenceBundle({
      binaries: [{ filename: "capture.png", contents: Buffer.from("png"), mediaType: "image/png", captureType: "screenshot", dimensions: { width: 1, height: 1 } }],
      relationships: [attempt.id],
      descriptor: (binaries) => screenshotDescriptor(workspace, binaries),
    });
    expect(bundle.binaries).toHaveLength(1);
    expect(bundle.descriptor.type).toBe("evidence");
    const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as { artifacts: { id: string }[] };
    expect(manifest.artifacts.map((artifact) => artifact.id)).toEqual(expect.arrayContaining([bundle.binaries[0]?.id, bundle.descriptor.id]));
    await workspace.close();
  });

  it("rejects a malformed evidence bundle before writing any media or descriptor", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile });
    await expect(workspace.registerEvidenceBundle({ binaries: [{ filename: "bad.png", contents: Buffer.from("png"), mediaType: "image/png", captureType: "screenshot" }], descriptor: () => ({ artifactType: "evidence" }) })).rejects.toThrow(/descriptor|contract/i);
    const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as { artifacts: unknown[] };
    expect(manifest.artifacts).toHaveLength(1);
    await expect(readdir(join(workspace.path, "evidence"))).rejects.toThrow(/ENOENT/);
    await workspace.close();
  });

  it("rolls back evidence files when the single manifest commit fails", async () => {
    const directory = await root();
    const failure = failNextManifestWrite();
    const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile, persistence: failure.persistence });
    const attempt = await registerEvidenceAttempt(workspace);
    failure.arm();
    await expect(workspace.registerEvidenceBundle({ binaries: [{ filename: "rollback.png", contents: Buffer.from("png"), mediaType: "image/png", captureType: "screenshot", dimensions: { width: 1, height: 1 } }], relationships: [attempt.id], descriptor: (binaries) => screenshotDescriptor(workspace, binaries) })).rejects.toThrow(/manifest/i);
    const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as { artifacts: unknown[] };
    expect(manifest.artifacts).toHaveLength(3);
    await expect(readdir(join(workspace.path, "evidence"))).resolves.toEqual([]);
    await workspace.close();
  });

  it("waits for a late multi-binary write failure before rolling back every unregistered file", async () => {
    const directory = await root();
    const failure = failSecondEvidenceBinaryWrite();
    const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile, persistence: failure.persistence });
    const attempt = await registerEvidenceAttempt(workspace);
    await expect(workspace.registerEvidenceBundle({
      binaries: ["first", "second", "third"].map((filename) => ({ filename: `${filename}.png`, contents: Buffer.from(filename), mediaType: "image/png", captureType: "screenshot" as const, dimensions: { width: 1, height: 1 } })),
      relationships: [attempt.id],
      descriptor: (binaries) => screenshotDescriptor(workspace, binaries),
    })).rejects.toThrow(/late evidence binary write failure/i);

    const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as { artifacts: unknown[] };
    expect(manifest.artifacts).toHaveLength(3);
    await expect(readdir(join(workspace.path, "evidence"))).resolves.toEqual([]);
    await workspace.close();
  });

  it.each([
    ["path", { relativePath: "evidence/forged.png" }],
    ["checksum", { sha256: "a".repeat(64) }],
    ["media type", { mediaType: "application/json" }],
  ])("rejects a forged primary descriptor %s before persistence", async (_name, override) => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile });
    const attempt = await registerEvidenceAttempt(workspace);
    await expect(workspace.registerEvidenceBundle({
      binaries: [{ filename: "capture.png", contents: Buffer.from("png"), mediaType: "image/png", captureType: "screenshot", dimensions: { width: 1, height: 1 } }],
      relationships: [attempt.id],
      descriptor: (binaries) => screenshotDescriptor(workspace, binaries, override),
    })).rejects.toThrow(/primary|descriptor|binding/i);

    await expect(readdir(join(workspace.path, "evidence"))).rejects.toThrow(/ENOENT/);
    await workspace.close();
  });

  it("rejects a rechecksummed persisted descriptor whose primary binary binding was tampered", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile });
    const attempt = await registerEvidenceAttempt(workspace);
    const bundle = await workspace.registerEvidenceBundle({
      binaries: [{ filename: "capture.png", contents: Buffer.from("png"), mediaType: "image/png", captureType: "screenshot", dimensions: { width: 1, height: 1 } }],
      relationships: [attempt.id],
      descriptor: (binaries) => screenshotDescriptor(workspace, binaries),
    });
    const descriptor = JSON.parse(await readFile(bundle.descriptor.absolutePath, "utf8")) as Record<string, unknown>;
    descriptor.mediaType = "application/json";
    const tampered = `${JSON.stringify(descriptor, null, 2)}\n`;
    await writeFile(bundle.descriptor.absolutePath, tampered);
    const manifestPath = join(workspace.path, "artifact-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; sha256: string }[] };
    const record = manifest.artifacts.find((artifact) => artifact.id === bundle.descriptor.id);
    if (!record) throw new Error("Expected evidence descriptor record");
    record.sha256 = sha256Text(tampered);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect((await workspace.validate("execute")).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_REFERENCE", message: expect.stringMatching(/primary|descriptor/i) }),
    ]));
    await workspace.close();
  });
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

  it("waits for an already-started registration before close releases the run lock", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const largeCase = {
      ...testCase("TC-CLOSE"),
      steps: Array.from({ length: 5_000 }, (_, index) => ({ id: `step-${index}`, action: "navigate", sideEffect: "none" })),
    };
    const sourcePath = join(directory, "close-case.json");
    await writeFile(sourcePath, JSON.stringify(largeCase));
    let registrationSettled = false;
    const registration = workspace.registerArtifact({
      type: "test-case",
      sourcePath,
      relationships: [],
    }).finally(() => {
      registrationSettled = true;
    });

    await workspace.close();
    expect(registrationSettled).toBe(true);
    await registration;

    const reopened = await RunWorkspace.open(directory, workspace.runId);
    expect((await reopened.validate("plan")).diagnostics).toEqual([]);
    await reopened.close();
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

  it("rejects registrations started after finalization claims its exclusive barrier", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const finalizing = workspace.finalize();

    await expect(registerDocument(workspace, "test-case", "late-case.json", testCase("TC-LATE"))).rejects.toThrow(/finaliz|terminal|write/i);
    await expect(finalizing).resolves.toMatchObject({ valid: true });
  });

  it("drains an already-started registration and finalizes one stable artifact set", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile });
    await registerDocument(workspace, "test-case", "case.json", testCase("TC-STABLE"));
    const sourcePath = join(directory, "result.json");
    await writeFile(sourcePath, JSON.stringify(testResult(workspace, "TC-STABLE")));
    const registration = workspace.registerArtifact({
      type: "test-result",
      sourcePath,
      relationships: [],
    });
    const finalizing = workspace.finalize();

    await expect(registration).resolves.toMatchObject({ type: "test-result" });
    await expect(finalizing).resolves.toMatchObject({ valid: true });
    expect(JSON.parse(await readFile(join(workspace.path, "run-metadata.json"), "utf8"))).toMatchObject({ status: "COMPLETED" });
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

  it("keeps in-memory metadata retryable when the FINALIZING write fails", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({
      root: directory,
      mode: "plan",
      environmentProfile,
      persistence: failMetadataStatusOnce("FINALIZING"),
    });

    await expect(workspace.finalize()).rejects.toThrow(/injected/i);
    expect(JSON.parse(await readFile(join(workspace.path, "run-metadata.json"), "utf8"))).toMatchObject({ status: "RUNNING" });
    await expect(workspace.finalize()).resolves.toMatchObject({ valid: true });
  });

  it("recovers to RUNNING when the terminal metadata write fails and retries", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({
      root: directory,
      mode: "plan",
      environmentProfile,
      persistence: failMetadataStatusOnce("COMPLETED"),
    });

    await expect(workspace.finalize()).rejects.toThrow(/injected/i);
    expect(JSON.parse(await readFile(join(workspace.path, "run-metadata.json"), "utf8"))).toMatchObject({ status: "RUNNING" });
    await expect(workspace.finalize()).resolves.toMatchObject({ valid: true });
  });

  it.each([
    ["COMPLETED", "plan", undefined],
    ["COMPLETED_WITH_FAILURES", "full", undefined],
    ["BLOCKED", "plan", "BLOCKED"],
    ["ABORTED", "plan", "ABORTED"],
  ] as const)("supports the %s terminal outcome", async (expectedStatus, mode, outcome) => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode, environmentProfile });

    await workspace.finalize(mode, outcome);
    expect(JSON.parse(await readFile(join(workspace.path, "run-metadata.json"), "utf8"))).toMatchObject({
      status: expectedStatus,
      finalizedProfile: { name: mode, version: "1.0.0" },
    });
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
      "evidenceGapId: GAP-1",
      `runId: ${workspace.runId}`,
      "scope: operational",
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

  it("serializes concurrent manifest updates without losing artifacts or creating orphans", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });

    const [first, second] = await Promise.all([
      registerDocument(workspace, "test-case", "concurrent-1.json", testCase("TC-CONCURRENT-1")),
      registerDocument(workspace, "test-case", "concurrent-2.json", testCase("TC-CONCURRENT-2")),
    ]);
    const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as { artifacts: { id: string }[] };
    expect(manifest.artifacts.map((artifact) => artifact.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect((await workspace.validate("plan")).diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("ORPHAN_FILE");
  });

  it("removes a canonical artifact when its manifest transaction fails and permits a clean retry", async () => {
    const directory = await root();
    const failure = failNextManifestWrite();
    const workspace = await RunWorkspace.create({
      root: directory,
      mode: "plan",
      environmentProfile,
      persistence: failure.persistence,
    });
    const sourcePath = join(directory, "manifest-retry.json");
    await writeFile(sourcePath, JSON.stringify(testCase("TC-MANIFEST-RETRY")));
    failure.arm();

    await expect(workspace.registerArtifact({
      type: "test-case",
      sourcePath,
      relationships: [],
    })).rejects.toThrow(/manifest write failure/i);
    expect((await workspace.validate("plan")).diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("ORPHAN_FILE");

    await expect(workspace.registerArtifact({
      type: "test-case",
      sourcePath,
      relationships: [],
    })).resolves.toMatchObject({ type: "test-case" });
    await expect(workspace.validate("plan")).resolves.toMatchObject({ valid: true, diagnostics: [] });
  });

  it("rejects persisted artifact relabeling and unknown manifest relationships", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile });
    await registerDocument(workspace, "test-case", "case-1.json", testCase("TC-RELABEL-1"));
    const relabeled = await registerDocument(workspace, "test-case", "case-2.json", testCase("TC-RELABEL-2"));
    const manifestPath = join(workspace.path, "artifact-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; type: string; relationships: string[] }[] };
    const record = manifest.artifacts.find((artifact) => artifact.id === relabeled.id);
    if (!record) throw new Error("Expected relabeled record");
    record.type = "test-result";
    record.relationships = ["missing-artifact"];
    await writeFile(manifestPath, JSON.stringify(manifest));

    const result = await workspace.validate("execute");
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining(["ARTIFACT_TYPE_MISMATCH", "UNKNOWN_RELATIONSHIP"]));
    await workspace.close();
    await expect(RunWorkspace.open(directory, workspace.runId)).rejects.toThrow(/artifact|relationship|binding/i);
  });

  it("revalidates persisted payload references instead of trusting manifest declarations", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile });
    await registerDocument(workspace, "test-case", "case.json", testCase("TC-TAMPER"));
    const resultRecord = await registerDocument(workspace, "test-result", "result.json", testResult(workspace, "TC-TAMPER"));
    const tampered = { ...testResult(workspace, "TC-MISSING"), attemptId: "ATTEMPT-1" };
    const contents = `${JSON.stringify(tampered, null, 2)}\n`;
    await writeFile(resultRecord.absolutePath, contents);
    const manifestPath = join(workspace.path, "artifact-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; sha256: string }[] };
    const record = manifest.artifacts.find((artifact) => artifact.id === resultRecord.id);
    if (!record) throw new Error("Expected result record");
    record.sha256 = sha256Text(contents);
    await writeFile(manifestPath, JSON.stringify(manifest));

    const validation = await workspace.validate("execute");
    expect(validation.valid).toBe(false);
    expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toContain("INVALID_REFERENCE");
    await workspace.close();
    await expect(RunWorkspace.open(directory, workspace.runId)).rejects.toThrow(/artifact|reference|binding/i);
  });

  it("rejects terminal metadata whose finalized profile differs from mode", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    await workspace.finalize();
    const metadataPath = join(workspace.path, "run-metadata.json");
    const persisted = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    await writeFile(metadataPath, JSON.stringify({ ...persisted, mode: "full" }));

    await expect(workspace.validate()).rejects.toThrow(/profile|mode|metadata/i);
    await expect(RunWorkspace.open(directory, workspace.runId)).rejects.toThrow(/profile|mode|metadata/i);
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

  it("rejects ambiguous attempt IDs and testcase revision mismatches", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile });
    await registerDocument(workspace, "test-case", "case.json", testCase("TC-REVISION"));

    await expect(registerDocument(workspace, "test-result", "wrong-revision.json", {
      ...testResult(workspace, "TC-REVISION"),
      testCaseRevisionId: "REV-WRONG",
    })).rejects.toThrow(/revision|reference|binding/i);
    await registerDocument(workspace, "test-result", "result.json", testResult(workspace, "TC-REVISION"));
    await expect(registerDocument(workspace, "test-result", "duplicate-attempt.json", {
      ...testResult(workspace, "TC-REVISION"),
      finishedAt: "2026-07-23T12:36:56.000Z",
    })).rejects.toThrow(/attempt|duplicate|ambiguous/i);
  });

  it("validates evidence and bug references by expected type and attempt", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "full", environmentProfile });
    await registerDocument(workspace, "test-case", "case.json", testCase("TC-1"));
    const attempt = await registerDocument(workspace, "test-result", "result.json", { ...testResult(workspace, "TC-1"), status: "FAILED", failureClassification: "PRODUCT_DEFECT" });

    const evidence = {
      artifactType: "evidence",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      evidenceId: "01K0ABCDEFGHJKMNPQRSTVWXYZ",
      runId: workspace.runId,
      attemptId: "ATTEMPT-1",
      testCaseId: "TC-1",
      testCaseRevisionId: "REV-TC-1",
      testCaseInstanceId: "TC-1--INSTANCE-1",
      kind: "log",
      capturedAt: "2026-07-23T12:34:56.000Z",
      sha256: "a".repeat(64),
      relativePath: "evidence/log.json",
      mediaType: "application/json",
      binaryArtifactIds: ["binary-1"],
      binaryArtifacts: [{ id: "binary-1", relativePath: "evidence/log.json", sha256: "a".repeat(64), mediaType: "application/json" }],
      provenance: { captureType: "log", dimensions: { width: 1, height: 1 }, dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 1, height: 1 }, url: "about:blank", viewport: { width: 1, height: 1 }, browser: "chromium", build: "test", capturedAt: "2026-07-23T12:34:56.000Z" },
    };
    await expect(registerDocument(workspace, "evidence", "foreign-evidence.json", { ...evidence, attemptId: "ATTEMPT-MISSING" })).rejects.toThrow(/attempt|reference|binding/i);
    const evidenceRecord = await registerDocument(workspace, "evidence", "evidence.json", evidence, [attempt.id]);

    const bug = {
      artifactType: "bug-report",
      schemaVersion: "1.0.0",
      producerVersion: "1.0.0",
      bugId: createRunScopedBugId("TC-1", workspace.runId, 1),
      runId: workspace.runId,
      attemptId: "ATTEMPT-1",
      triageStatus: "NEEDS_TRIAGE",
      expected: "test outcome",
      actual: "Unknown observed actual (no registered step, error, or telemetry observation).",
      environment: { environmentProfileId: environmentProfile.environmentProfileId, name: environmentProfile.name, classification: environmentProfile.classification, baseUrl: environmentProfile.baseUrl },
      reproduction: { attemptIds: ["ATTEMPT-1"], attempted: 1, total: 2, rate: "1/2", outcome: "RERUN_OMITTED_UNSAFE", unsafeRerunReason: "Unsafe to retry" },
      evidenceIds: [evidence.evidenceId],
      affectedAreas: ["TC-1"], openQuestions: ["No registered observable actual was available."], provenance: { sourceAttemptIds: ["ATTEMPT-1"], evidenceArtifactIds: [evidenceRecord.id] }, fingerprint: createBugFingerprint({ feature: "TC-1", expected: "test outcome", actual: "Unknown observed actual (no registered step, error, or telemetry observation).", affectedAreas: ["TC-1"] }), testPriority: "medium", open: true,
    };
    await expect(registerDocument(workspace, "bug-report", "foreign-bug-attempt.json", { ...bug, attemptId: "ATTEMPT-MISSING" })).rejects.toThrow(/attempt|reference|binding/i);
    await expect(registerDocument(workspace, "bug-report", "foreign-bug-evidence.json", { ...bug, evidenceIds: ["01K0ABCDEFGHJKMNPQRSTVWXY0"] })).rejects.toThrow(/evidence|reference|binding/i);
    await expect(registerDocument(workspace, "bug-report", "bug.json", bug, [attempt.id, evidenceRecord.id])).resolves.toMatchObject({ type: "bug-report" });
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
