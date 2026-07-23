import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RunWorkspace } from "../../src/core/run-workspace.js";
import { generateBugReport } from "../../src/operations/generate-bug-report.js";
import { generateQaReport } from "../../src/operations/generate-qa-report.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const environment = { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "ENV-REPORT", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false } as const;
const testCase = { artifactType: "test-case", schemaVersion: "1.0.0", producerVersion: "0.1.0", testCaseId: "TC-CHECKOUT", revisionId: "REV-1", instanceId: "INSTANCE-1", title: "Checkout saves an order", steps: [{ id: "open", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ-CHECKOUT", role: "buyer", behavior: "checkout", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "high", outcome: "Order confirmation is shown" } } as const;

function result(runId: string, attemptId: string, classification: "PRODUCT_DEFECT" | "TEST_DEFECT" = "PRODUCT_DEFECT") {
  return { artifactType: "test-result", schemaVersion: "1.0.0", producerVersion: "0.1.0", attemptId, runId, testCaseId: testCase.testCaseId, testCaseRevisionId: testCase.revisionId, testCaseInstanceId: testCase.instanceId, status: "FAILED", failureClassification: classification, startedAt: "2026-07-23T00:00:00.000Z", finishedAt: "2026-07-23T00:01:00.000Z" } as const;
}

async function evidence(workspace: RunWorkspace, attemptId: string) {
  return workspace.registerEvidenceBundle({
    binaries: [{ filename: "failure.txt", contents: Buffer.from("failure"), mediaType: "text/plain", captureType: "log" }],
    descriptor: (binaries) => ({ artifactType: "evidence", schemaVersion: "1.0.0", producerVersion: "0.1.0", evidenceId: "01K0ABCDEFGHJKMNPQRSTVWXYZ", runId: workspace.runId, attemptId, kind: "log", capturedAt: "2026-07-23T00:01:00.000Z", sha256: binaries[0]!.sha256, relativePath: binaries[0]!.relativePath, mediaType: "text/plain", binaryArtifactIds: binaries.map((binary) => binary.id), binaryArtifacts: binaries.map((binary) => ({ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType })), provenance: { captureType: "log", dimensions: { width: 1, height: 1 }, dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 1, height: 1 }, url: "https://example.test", viewport: { width: 1, height: 1 }, browser: "chromium", build: "build-1", capturedAt: "2026-07-23T00:01:00.000Z" } }),
  });
}

describe("report generation operations", () => {
  it("derives canonical bugs, gates, and reports only from registered attempts and evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-report-")); roots.push(root);
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
    await workspace.registerArtifactValue({ type: "test-case", value: testCase, relationships: [] });
    await workspace.registerArtifactValue({ type: "test-result", value: result(workspace.runId, "ATTEMPT-1"), relationships: [] });
    await workspace.registerArtifactValue({ type: "test-result", value: result(workspace.runId, "ATTEMPT-2"), relationships: [] });
    await evidence(workspace, "ATTEMPT-1");

    const bug = await generateBugReport({ workspace, attemptId: "ATTEMPT-1", reproductionAttemptIds: ["ATTEMPT-1", "ATTEMPT-2"] });
    expect(bug).toMatchObject({ kind: "BUG" });
    const report = await generateQaReport({ workspace, locale: "vi" });
    const registered = await workspace.readRegisteredArtifacts();

    expect(report.json).toContain("NOT_READY");
    expect(report.markdown).toContain("# Báo cáo QA");
    expect(registered.filter((artifact) => artifact.record.type === "bug-report")).toHaveLength(1);
    expect(registered.filter((artifact) => artifact.record.type === "release-gate")).toHaveLength(1);
    expect(registered.filter((artifact) => artifact.record.type === "qa-execution-report")).toHaveLength(1);
    await workspace.close();
  });

  it("does not let callers turn a non-product registered attempt into a bug", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-report-")); roots.push(root);
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
    await workspace.registerArtifactValue({ type: "test-case", value: testCase, relationships: [] });
    await workspace.registerArtifactValue({ type: "test-result", value: result(workspace.runId, "ATTEMPT-TEST", "TEST_DEFECT"), relationships: [] });

    await expect(generateBugReport({ workspace, attemptId: "ATTEMPT-TEST", triage: { status: "TRIAGED", severity: "Blocker", priorityRecommendation: "P0", testPriority: "critical", openQuestions: [] } })).resolves.toMatchObject({ kind: "INCIDENT" });
    expect((await workspace.readRegisteredArtifacts()).some((artifact) => artifact.record.type === "bug-report")).toBe(false);
    await workspace.close();
  });
});
