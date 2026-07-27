import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { annotateScreenshot } from "../../src/evidence/annotator.js";
import { validateAnnotation } from "../../src/contracts/validator.js";
import { sha256 } from "../../src/core/checksum.js";
import { atomicWriteFile } from "../../src/core/fs.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";

const roots: string[] = [];
const environmentProfile = { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "env-annotation", name: "Annotation", classification: "test", baseUrl: "https://example.test", productionReadOnly: false } as const;

async function workspaceRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "qa-evidence-"));
  roots.push(directory);
  return directory;
}

async function patternedPng(width = 120, height = 80): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    pixels[offset] = (x * 17 + y * 3) % 256;
    pixels[offset + 1] = (x * 7 + y * 19) % 256;
    pixels[offset + 2] = (x * 11 + y * 5) % 256;
    pixels[offset + 3] = 255;
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function pixel(bytes: Buffer, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4;
  return [...bytes.subarray(offset, offset + 4)];
}

async function registerRaw(workspace: RunWorkspace, options: { attemptId?: string; bytes?: Buffer } = {}) {
  const attemptId = options.attemptId ?? "attempt-1";
  const testCase = await workspace.registerArtifactValue({
    type: "test-case",
    relationships: [],
    value: { artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "0.1.0", testCaseId: "TC-ANNOTATION", revisionId: "REV-ANNOTATION", instanceId: "INSTANCE-ANNOTATION", title: "Annotation source", steps: [{ id: "step-1", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ-ANNOTATION", role: "member", behavior: "annotate", browser: "chromium", viewport: { width: 120, height: 80 }, accessibilityMethod: null, risk: "low", outcome: "annotated" } },
  });
  const result = await workspace.registerArtifactValue({
    type: "test-result",
    relationships: [testCase.id],
    value: { artifactType: "test-result", schemaVersion: "2.0.0", producerVersion: "0.1.0", attemptId, runId: workspace.runId, testCaseId: "TC-ANNOTATION", testCaseRevisionId: "REV-ANNOTATION", testCaseInstanceId: "INSTANCE-ANNOTATION", status: "FAILED", failureClassification: "TEST_DEFECT", observedEngine: "chromium", steps: [{ stepId: "step-1", status: "FAILED", durationMs: 1, failureOrigin: "assertion" }], startedAt: "2026-07-23T00:00:00.000Z", finishedAt: "2026-07-23T00:00:01.000Z" },
  });
  const bytes = options.bytes ?? await patternedPng();
  return workspace.registerEvidenceBundle({
    binaries: [{ filename: "sanitized-raw.png", contents: bytes, mediaType: "image/png", captureType: "screenshot", dimensions: { width: 120, height: 80 } }],
    relationships: [result.id],
    descriptor: (binaries) => ({ artifactType: "evidence", schemaVersion: "2.0.0", producerVersion: "0.1.0", evidenceId: "01HZX3Y6W4YB5FWG0RY9Q8Q2K7", runId: workspace.runId, subject: { kind: "attempt", attemptId, testCaseId: "TC-ANNOTATION", testCaseRevisionId: "REV-ANNOTATION", testCaseInstanceId: "INSTANCE-ANNOTATION" }, kind: "screenshot", capturedAt: "2026-07-23T00:00:00.000Z", sha256: binaries[0]?.sha256, relativePath: binaries[0]?.relativePath, mediaType: binaries[0]?.mediaType, binaryArtifactIds: binaries.map((binary) => binary.id), binaryArtifacts: binaries.map((binary) => ({ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType })), provenance: { captureType: "screenshot", dimensions: { width: 120, height: 80 }, dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 120, height: 80 }, url: "https://example.test", viewport: { width: 120, height: 80 }, browser: "chromium", build: "build-1", capturedAt: "2026-07-23T00:00:00.000Z", testcaseId: "TC-ANNOTATION" } }),
  });
}

function failNextAnnotationBundleWrite(kind: "descriptor" | "manifest") {
  let armed = false;
  return {
    arm(): void { armed = true; },
    persistence: {
      async writeAtomic(root: string, path: string, contents: string | Uint8Array): Promise<void> {
        const shouldFail = armed && (kind === "descriptor" ? path.endsWith("-evidence.json") : path.endsWith("artifact-manifest.json"));
        if (shouldFail) {
          armed = false;
          throw new Error(`Injected annotation ${kind} write failure`);
        }
        await atomicWriteFile(root, path, contents);
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("annotateScreenshot", () => {
  it("validates the annotation contract with full capture provenance", () => {
    expect(validateAnnotation({
      artifactType: "annotation", schemaVersion: "1.0.0", producerVersion: "0.1.0", evidenceId: "evidence-1", captureType: "screenshot", sourceEvidenceArtifactId: "source-evidence", sourceEvidenceSha256: "b".repeat(64), sourceBinaryArtifactId: "source-binary", rawSha256: "a".repeat(64), annotations: [],
      provenance: { runId: "run-1", attemptId: "attempt-1", url: "https://example.test", viewport: { width: 1, height: 1 }, browser: "chromium", build: "build-1", capturedAt: "2026-07-23T00:00:00.000Z", dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 1, height: 1 } },
    }).valid).toBe(true);
  });

  it("keeps the sanitized raw PNG unchanged and writes a separate annotated PNG with provenance", async () => {
    const directory = await workspaceRoot();
    const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile });
    const rawBundle = await registerRaw(workspace);
    const raw = rawBundle.binaries[0];
    if (!raw) throw new Error("Expected raw evidence binary");
    const rawPath = raw.absolutePath;
    const checksumBefore = await sha256(rawPath);

    const evidence = await annotateScreenshot({
      workspace,
      rawEvidenceDescriptorId: rawBundle.descriptor.id,
      rawBinaryArtifactId: raw.id,
      annotations: [{ id: "one", x: 10, y: 10, width: 30, height: 20, label: "Input", cssBox: { x: 10, y: 10, width: 30, height: 20 } }],
    });

    expect(await sha256(rawPath)).toBe(checksumBefore);
    expect(await readFile(evidence.annotated.absolutePath)).not.toEqual(await readFile(rawPath));
    expect(await sharp(evidence.annotated.absolutePath).metadata()).toMatchObject({ width: 120, height: 80, format: "png" });
    expect(evidence.raw.sha256).toBe(checksumBefore);
    expect(evidence.annotated.relativePath).toMatch(/^evidence\//);
    expect(evidence.provenance.normalizedPixelBoxes).toHaveLength(1);
    expect(evidence.provenance.dimensions).toEqual({ width: 120, height: 80 });
    expect(Object.isFrozen(evidence.provenance.normalizedPixelBoxes)).toBe(true);
    const descriptor = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.id === evidence.descriptorArtifactId);
    expect(descriptor?.value.derivation).toEqual({ sourceEvidenceArtifactId: rawBundle.descriptor.id, sourceEvidenceSha256: rawBundle.descriptor.sha256, sourceBinaryArtifactId: raw.id, sourceRawSha256: checksumBefore });
    await workspace.close();
    const reopened = await RunWorkspace.open(directory, workspace.runId);
    await expect(reopened.validate()).resolves.toMatchObject({ valid: true });
    await reopened.close();
  });

  it("changes annotation overlay pixels on a nonblank pattern while preserving the raw bytes and checksum", async () => {
    const workspace = await RunWorkspace.create({ root: await workspaceRoot(), mode: "execute", environmentProfile });
    const rawBundle = await registerRaw(workspace);
    const raw = rawBundle.binaries[0];
    if (!raw) throw new Error("Expected raw evidence binary");
    const before = await readFile(raw.absolutePath);
    const checksum = await sha256(raw.absolutePath);

    const annotated = await annotateScreenshot({ workspace, rawEvidenceDescriptorId: rawBundle.descriptor.id, rawBinaryArtifactId: raw.id, annotations: [{ id: "one", x: 10, y: 10, width: 30, height: 20, label: "Input", cssBox: { x: 10, y: 10, width: 30, height: 20 } }] });
    const rawPixels = await sharp(before).ensureAlpha().raw().toBuffer();
    const annotatedPixels = await sharp(annotated.annotated.absolutePath).ensureAlpha().raw().toBuffer();

    expect(await readFile(raw.absolutePath)).toEqual(before);
    expect(await sha256(raw.absolutePath)).toBe(checksum);
    expect(pixel(annotatedPixels, 120, 10, 10)).not.toEqual(pixel(rawPixels, 120, 10, 10));
    expect(annotatedPixels).not.toEqual(rawPixels);
    await workspace.close();
  });

  it("rejects forged descriptors, foreign binaries, and tampered raw bindings before annotation", async () => {
    const first = await RunWorkspace.create({ root: await workspaceRoot(), mode: "execute", environmentProfile });
    const second = await RunWorkspace.create({ root: await workspaceRoot(), mode: "execute", environmentProfile: { ...environmentProfile, environmentProfileId: "env-annotation-second" } });
    const firstBundle = await registerRaw(first);
    const secondBundle = await registerRaw(second);
    const firstBinary = firstBundle.binaries[0];
    const secondBinary = secondBundle.binaries[0];
    if (!firstBinary || !secondBinary) throw new Error("Expected raw evidence binaries");
    const annotation = [{ id: "one", x: 10, y: 10, width: 30, height: 20, cssBox: { x: 10, y: 10, width: 30, height: 20 } }];

    await expect(annotateScreenshot({ workspace: first, rawEvidenceDescriptorId: firstBinary.id, rawBinaryArtifactId: firstBinary.id, annotations: annotation })).rejects.toThrow(/authoritative|source/i);
    await expect(annotateScreenshot({ workspace: second, rawEvidenceDescriptorId: firstBundle.descriptor.id, rawBinaryArtifactId: secondBinary.id, annotations: annotation })).rejects.toThrow(/authoritative|source/i);
    await expect(annotateScreenshot({ workspace: second, rawEvidenceDescriptorId: secondBundle.descriptor.id, rawBinaryArtifactId: firstBinary.id, annotations: annotation })).rejects.toThrow(/authoritative|source/i);
    await first.close();
    await second.close();
  });

  it.each(["checksum", "media type"] as const)("rejects a raw source with a tampered %s binding", async (kind) => {
    const workspace = await RunWorkspace.create({ root: await workspaceRoot(), mode: "execute", environmentProfile });
    const rawBundle = await registerRaw(workspace);
    const raw = rawBundle.binaries[0];
    if (!raw) throw new Error("Expected raw evidence binary");
    if (kind === "checksum") {
      await writeFile(raw.absolutePath, "tampered");
    } else {
      const manifestPath = join(workspace.path, "artifact-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; mediaType?: string }[] };
      const binary = manifest.artifacts.find((artifact) => artifact.id === raw.id);
      if (!binary) throw new Error("Expected raw binary manifest record");
      binary.mediaType = "application/json";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    await expect(annotateScreenshot({ workspace, rawEvidenceDescriptorId: rawBundle.descriptor.id, rawBinaryArtifactId: raw.id, annotations: [] })).rejects.toThrow(/binding|source|invalid/i);
    await workspace.close();
  });

  it.each(["descriptor", "manifest"] as const)("rolls back the annotated binary when its bundle %s write fails", async (kind) => {
    const failure = failNextAnnotationBundleWrite(kind);
    const workspace = await RunWorkspace.create({ root: await workspaceRoot(), mode: "execute", environmentProfile, persistence: failure.persistence });
    const rawBundle = await registerRaw(workspace);
    const raw = rawBundle.binaries[0];
    if (!raw) throw new Error("Expected raw evidence binary");
    failure.arm();

    await expect(annotateScreenshot({ workspace, rawEvidenceDescriptorId: rawBundle.descriptor.id, rawBinaryArtifactId: raw.id, annotations: [] })).rejects.toThrow(new RegExp(`annotation ${kind} write failure`, "i"));
    expect(await readdir(join(workspace.path, "evidence"))).toEqual([raw.relativePath.split("/").at(-1)]);
    const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as { artifacts: { id: string }[] };
    expect(manifest.artifacts.map((artifact) => artifact.id)).toEqual(expect.arrayContaining([raw.id, rawBundle.descriptor.id]));
    expect(manifest.artifacts).toHaveLength(5);
    await workspace.close();
  });

  it.each([NaN, Infinity, -1, 111])("rejects invalid annotation geometry (%s)", async (x) => {
    const workspace = await RunWorkspace.create({ root: await workspaceRoot(), mode: "execute", environmentProfile });
    const rawBundle = await registerRaw(workspace);
    const raw = rawBundle.binaries[0];
    if (!raw) throw new Error("Expected raw evidence binary");
    await expect(annotateScreenshot({ workspace, rawEvidenceDescriptorId: rawBundle.descriptor.id, rawBinaryArtifactId: raw.id, annotations: [{ id: "bad", x, y: 10, width: 30, height: 20, cssBox: { x: 10, y: 10, width: 30, height: 20 } }] })).rejects.toThrow(/geometry|bounds/i);
    await workspace.close();
  });

  it("renders hostile label and footer text as harmless literal text", async () => {
    const hostile = `${"&".repeat(300)}</text><rect x="0" y="0" width="8" height="8" fill="#00ff00"/>`;
    const workspace = await RunWorkspace.create({ root: await workspaceRoot(), mode: "execute", environmentProfile });
    const rawBundle = await registerRaw(workspace, { attemptId: hostile });
    const raw = rawBundle.binaries[0];
    if (!raw) throw new Error("Expected raw evidence binary");
    const rawPixels = await sharp(raw.absolutePath).ensureAlpha().raw().toBuffer();

    const annotated = await annotateScreenshot({ workspace, rawEvidenceDescriptorId: rawBundle.descriptor.id, rawBinaryArtifactId: raw.id, annotations: [{ id: "one", x: 20, y: 20, width: 30, height: 20, label: "</text><rect x=\"0\" y=\"0\" width=\"8\" height=\"8\" fill=\"#00ff00\"/>", cssBox: { x: 20, y: 20, width: 30, height: 20 } }] });
    const annotatedPixels = await sharp(annotated.annotated.absolutePath).ensureAlpha().raw().toBuffer();

    expect(await sharp(annotated.annotated.absolutePath).metadata()).toMatchObject({ width: 120, height: 80, format: "png" });
    expect(pixel(annotatedPixels, 120, 0, 0)).toEqual(pixel(rawPixels, 120, 0, 0));
    await workspace.close();
  });
});
