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
const testCase = { artifactType: "test-case", schemaVersion: "3.0.0", producerVersion: "0.1.0", testCaseId: "TC-CHECKOUT", revisionId: "REV-1", instanceId: "INSTANCE-1", title: "Checkout saves an order", steps: [{ id: "open", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ-CHECKOUT", role: "buyer", behavior: "checkout", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "high", outcome: "Order confirmation is shown" } } as const;

function result(runId: string, attemptId: string, classification: "PRODUCT_DEFECT" | "TEST_DEFECT" = "PRODUCT_DEFECT") {
  return { artifactType: "test-result", schemaVersion: "3.0.0", producerVersion: "0.1.0", attemptId, runId, testCaseId: testCase.testCaseId, testCaseRevisionId: testCase.revisionId, testCaseInstanceId: testCase.instanceId, status: "FAILED", failureClassification: classification, observedEngine: "chromium", steps: [{ stepId: "open", status: "FAILED", durationMs: 1, failureOrigin: "assertion" }], startedAt: "2026-07-23T00:00:00.000Z", finishedAt: "2026-07-23T00:01:00.000Z" } as const;
}

async function evidence(workspace: RunWorkspace, attemptId: string) {
  const attempt = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === attemptId);
  if (!attempt) throw new Error("Expected registered attempt");
  return workspace.registerEvidenceBundle({
    binaries: [{ filename: "failure.txt", contents: Buffer.from("failure"), mediaType: "text/plain", captureType: "log" }],
    relationships: [attempt.record.id],
    descriptor: (binaries) => ({ artifactType: "evidence", schemaVersion: "3.0.0", producerVersion: "0.1.0", evidenceId: "01K0ABCDEFGHJKMNPQRSTVWXYZ", runId: workspace.runId, subject: { kind: "attempt", attemptId, testCaseId: testCase.testCaseId, testCaseRevisionId: testCase.revisionId, testCaseInstanceId: testCase.instanceId }, kind: "log", capturedAt: "2026-07-23T00:01:00.000Z", sha256: binaries[0]!.sha256, relativePath: binaries[0]!.relativePath, mediaType: "text/plain", binaryArtifactIds: binaries.map((binary) => binary.id), binaryArtifacts: binaries.map((binary) => ({ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType })), telemetryFindings: [{ kind: "console", level: "error", message: "scrubbed telemetry" }], provenance: { captureType: "log", url: "https://example.test", browser: "chromium", build: "build-1", capturedAt: "2026-07-23T00:01:00.000Z" } }),
  });
}

describe("report generation operations", () => {
  it("derives canonical bugs, gates, and reports only from registered attempts and evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-report-")); roots.push(root);
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
    const registeredCase = await workspace.registerArtifactValue({ type: "test-case", value: testCase, relationships: [] });
    await workspace.registerArtifactValue({ type: "test-result", value: result(workspace.runId, "ATTEMPT-1"), relationships: [registeredCase.id] });
    await workspace.registerArtifactValue({ type: "test-result", value: result(workspace.runId, "ATTEMPT-2"), relationships: [registeredCase.id] });
    await evidence(workspace, "ATTEMPT-1");

    const bug = await generateBugReport({ workspace, attemptId: "ATTEMPT-1", reproductionAttemptIds: ["ATTEMPT-1", "ATTEMPT-2"], triage: { status: "TRIAGED", severity: "Critical", priorityRecommendation: "P0", testPriority: "critical", openQuestions: [] } });
    expect(bug).toMatchObject({ kind: "BUG" });
    const revision = await generateBugReport({ workspace, attemptId: "ATTEMPT-2", reproductionAttemptIds: ["ATTEMPT-2", "ATTEMPT-1"], triage: { status: "TRIAGED", severity: "Major", priorityRecommendation: "P2", testPriority: "high", openQuestions: [] } });
    expect(revision).toMatchObject({ kind: "BUG" });
    const revisions = (await workspace.readRegisteredArtifacts()).filter((artifact) => artifact.record.type === "bug-report");
    expect(revisions).toHaveLength(2);
    expect(revisions[1]?.value).toMatchObject({ bugId: revisions[0]?.value.bugId, revision: 2, supersedesArtifactId: revisions[0]?.record.id });
    const report = await generateQaReport({ workspace, locale: "vi" });
    const registered = await workspace.readRegisteredArtifacts();

    const model = JSON.parse(report.json) as { bugs: unknown[]; criticalFindings: string[]; remainingRisks: string[]; summary: string; releaseRecommendation: string };
    expect(model.releaseRecommendation).toBe("READY_WITH_RISKS");
    expect(report.json).toContain("scrubbed telemetry");
    expect(model.bugs).toHaveLength(2);
    expect(model.criticalFindings).toEqual([]);
    expect(model.remainingRisks).toEqual([revisions[0]?.value.bugId]);
    expect(model.summary).toContain("1 open product bug");
    expect(report.markdown).toContain("# Báo cáo QA");
    expect(registered.filter((artifact) => artifact.record.type === "bug-report")).toHaveLength(2);
    expect(registered.filter((artifact) => artifact.record.type === "release-gate")).toHaveLength(1);
    expect(registered.filter((artifact) => artifact.record.type === "qa-execution-report")).toHaveLength(1);
    await workspace.close();
  });

  /**
   * Lane 2 (ADR-0010). Before Phase 7 both of these projections filtered `test-result` alone, so a run
   * credited entirely by a `test-result-batch` reported "0 registered attempts evaluated" beside a gate
   * that had already credited every entry — and a skipped observed spec vanished from `excludedNotRun`
   * while `NOT_RUN` was exactly what the entry said.
   */
  it("counts observed batch entries in the summary and lists a NOT_RUN entry as excluded", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-report-batch-")); roots.push(root);
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
    const registeredCase = await workspace.registerArtifactValue({ type: "test-case", value: testCase, relationships: [] });
    const entry = (entryId: string, status: "PASSED" | "NOT_RUN") => ({ entryId, testCaseId: testCase.testCaseId, testCaseRevisionId: testCase.revisionId, testCaseInstanceId: testCase.instanceId, status, failureClassification: status === "PASSED" ? "NONE" : "UNDETERMINED", executionSurface: "api", steps: [{ stepId: "result-0", status, durationMs: 1 }] });
    await workspace.registerArtifactValue({
      type: "test-result-batch", provenance: "runtime-observed", relationships: [registeredCase.id],
      value: { artifactType: "test-result-batch", schemaVersion: "4.0.0", producerVersion: "0.1.0", executionId: "EXEC-1", runId: workspace.runId, commitSha: "a".repeat(40), specTreeSha256: "b".repeat(64), startedAt: "2026-07-23T00:00:00.000Z", finishedAt: "2026-07-23T00:01:00.000Z", entries: [entry("E-1", "PASSED"), entry("E-2", "NOT_RUN")] },
    });

    const report = await generateQaReport({ workspace });

    const model = JSON.parse(report.json) as { summary: string; excludedNotRun: string[] };
    expect(model.summary).toContain("2 registered attempts evaluated");
    expect(model.excludedNotRun).toEqual([testCase.testCaseId]);
    await workspace.close();
  });

  it("does not let callers turn a non-product registered attempt into a bug", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-report-")); roots.push(root);
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
    const registeredCase = await workspace.registerArtifactValue({ type: "test-case", value: testCase, relationships: [] });
    await workspace.registerArtifactValue({ type: "test-result", value: result(workspace.runId, "ATTEMPT-TEST", "TEST_DEFECT"), relationships: [registeredCase.id] });

    await expect(generateBugReport({ workspace, attemptId: "ATTEMPT-TEST", triage: { status: "TRIAGED", severity: "Blocker", priorityRecommendation: "P0", testPriority: "critical", openQuestions: [] } })).rejects.toThrow(/evidence|gap/i);
    expect((await workspace.readRegisteredArtifacts()).some((artifact) => artifact.record.type === "bug-report")).toBe(false);
    await workspace.close();
  });
});
