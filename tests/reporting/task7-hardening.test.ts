import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateArtifact } from "../../src/contracts/validator.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { generateQaReport } from "../../src/operations/generate-qa-report.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const environment = { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "ENV-1", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false } as const;

describe("Task 7 hardening contracts", () => {
  it("rejects a cross-run duplicate hint without a checksum-bound source artifact", () => {
    expect(validateArtifact("bug-report", {
      artifactType: "bug-report", schemaVersion: "1.0.0", producerVersion: "1.0.0",
      bugId: "BUG-CHECKOUT-ABC123-001", runId: "run-abc123", attemptId: "ATTEMPT-1",
      triageStatus: "NEEDS_TRIAGE", expected: "Order confirmation appears", actual: "Request failed",
      environment: { environmentProfileId: "ENV-1", name: "test", classification: "test", baseUrl: "https://example.test" },
      reproduction: { attemptIds: ["ATTEMPT-1"], attempted: 1, total: 2, rate: "1/2", outcome: "RERUN_OMITTED_UNSAFE", unsafeRerunReason: "Unsafe" },
      evidenceIds: ["EVIDENCE-1"], affectedAreas: ["TC-CHECKOUT"], openQuestions: [],
      provenance: { sourceAttemptIds: ["ATTEMPT-1"], evidenceArtifactIds: ["artifact-evidence"] },
      fingerprint: "a".repeat(64), testPriority: "medium", open: true,
      possibleDuplicateSources: [{ runId: "run-def456", artifactId: "bug-artifact", bugId: "BUG-CHECKOUT-DEF456-001", fingerprint: "a".repeat(64) }],
    }).valid).toBe(false);
  });

  it("rejects a caller-fabricated READY gate instead of accepting a subset of manifest facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-task7-")); roots.push(root);
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
    await expect(workspace.registerArtifactValue({ type: "release-gate", relationships: [], value: {
      artifactType: "release-gate", schemaVersion: "1.0.0", producerVersion: "1.0.0", runId: workspace.runId,
      sourceArtifacts: [], recommendation: "READY", ruleInputs: { artifactsValid: true, coverage: { requiredMissing: [], optionalGaps: [], requiredHighRisk: [] }, bugs: [], sharedBlockers: [] }, verdicts: [],
    } })).rejects.toThrow(/complete|derived|snapshot/i);
    await workspace.close();
  });

  it("rejects a rechecksummed release-gate fact tamper while opening the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-task7-")); roots.push(root);
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
    const generated = await generateQaReport({ workspace });
    const manifestPath = join(root, "qa-results", workspace.runId, "artifact-manifest.json");
    const gatePath = join(root, "qa-results", workspace.runId, generated.gate.relativePath);
    const gate = JSON.parse(await readFile(gatePath, "utf8")) as Record<string, unknown>;
    gate.ruleInputs = { artifactsValid: true, coverage: { requiredMissing: [], optionalGaps: [], requiredHighRisk: [] }, bugs: [], sharedBlockers: [] };
    const contents = `${JSON.stringify(gate, null, 2)}\n`;
    await writeFile(gatePath, contents);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; sha256: string }[] };
    const gateRecord = manifest.artifacts.find((artifact) => artifact.id === generated.gate.id)!;
    gateRecord.sha256 = createHash("sha256").update(contents).digest("hex");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await workspace.close();
    await expect(RunWorkspace.open(root, workspace.runId)).rejects.toThrow(/release gate|manifest facts|binding/i);
  });
});
