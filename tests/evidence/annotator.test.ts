import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { annotateScreenshot } from "../../src/evidence/annotator.js";
import { validateAnnotation } from "../../src/contracts/validator.js";
import { sha256 } from "../../src/core/checksum.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";

describe("annotateScreenshot", () => {
  it("validates the annotation contract with full capture provenance", () => {
    expect(validateAnnotation({
      artifactType: "annotation", schemaVersion: "1.0.0", producerVersion: "0.1.0", evidenceId: "evidence-1", captureType: "screenshot", rawSha256: "a".repeat(64), annotations: [],
      provenance: { runId: "run-1", attemptId: "attempt-1", url: "https://example.test", viewport: { width: 1, height: 1 }, browser: "chromium", build: "build-1", capturedAt: "2026-07-23T00:00:00.000Z", dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 1, height: 1 } },
    }).valid).toBe(true);
  });

  it("keeps the sanitized raw PNG unchanged and writes a separate annotated PNG with provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qa-evidence-"));
    const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile: { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "env-annotation", name: "Annotation", classification: "test", baseUrl: "https://example.test", productionReadOnly: false } });
    const raw = await workspace.registerBinaryArtifact({ type: "evidence", filename: "sanitized-raw.png", contents: await sharp({ create: { width: 120, height: 80, channels: 4, background: "#ffffff" } }).png().toBuffer(), mediaType: "image/png", captureType: "screenshot", dimensions: { width: 120, height: 80 }, relationships: [] });
    const rawPath = raw.absolutePath;
    const checksumBefore = await sha256(rawPath);

    const evidence = await annotateScreenshot({
      rawPath,
      workspace,
      rawBinaryArtifactId: raw.id,
      provenance: { evidenceId: "01HZX3Y6W4YB5FWG0RY9Q8Q2K7", runId: "run-1", attemptId: "attempt-1", captureType: "screenshot", dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 120, height: 80 }, url: "https://example.test", viewport: { width: 120, height: 80 }, browser: "chromium", build: "build-1", capturedAt: "2026-07-23T00:00:00.000Z" },
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
    await workspace.close();
  });
});
