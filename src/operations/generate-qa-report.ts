import { deriveReleaseGateFromWorkspaceArtifacts } from "../reporting/release-gate.js";
import { toQaExecutionReport, type QaReportModel } from "../reporting/report-model.js";
import { renderCanonicalJson } from "../reporting/render-json.js";
import { renderMarkdown } from "../reporting/render-markdown.js";
import { evidenceAttemptId } from "../core/artifact-record.js";
import type { ArtifactRecord, RunWorkspace } from "../core/run-workspace.js";
import { isRecord } from "../core/values.js";

type Values = Readonly<Record<string, unknown>>;
function str(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }

/** Generates both report projections from immutable registered artifacts, then registers canonical gate and report artifacts. */
export async function generateQaReport(input: Readonly<{ workspace: RunWorkspace; locale?: "en" | "vi" }>): Promise<Readonly<{ gate: ArtifactRecord; report: ArtifactRecord; json: string; markdown: string }>> {
  const artifacts = await input.workspace.readRegisteredArtifacts();
  if (artifacts.some((artifact) => artifact.record.type === "release-gate" || artifact.record.type === "qa-execution-report")) throw new Error("A release gate and QA report are immutable and may be generated once per run");
  const bugs = artifacts.filter((artifact) => artifact.record.type === "bug-report").map((artifact) => artifact.value);
  const gateResult = deriveReleaseGateFromWorkspaceArtifacts(artifacts.map((artifact) => ({
    record: { id: artifact.record.id, sha256: artifact.record.sha256, type: artifact.record.type, provenance: artifact.record.provenance }, value: artifact.value,
  })));
  const currentBugs = gateResult.ruleInputs.bugs;
  const currentOpenBugs = currentBugs.filter((bug) => bug.open);
  const gateValue = { artifactType: "release-gate", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: input.workspace.runId, ...gateResult };
  const gate = await input.workspace.registerArtifactValue({ type: "release-gate", value: gateValue, relationships: artifacts.map((artifact) => artifact.record.id), provenance: "runtime" });
  const evidence = artifacts.filter((artifact) => artifact.record.type === "evidence");
  const build = evidence.map((artifact) => isRecord(artifact.value.provenance) ? str(artifact.value.provenance.build) : undefined).find((value) => value !== undefined) ?? "unknown";
  const incidents = artifacts.filter((artifact) => artifact.record.type === "incident").map((artifact) => artifact.value);
  const evidenceGaps = artifacts.filter((artifact) => artifact.record.type === "evidence-gap").map((artifact) => artifact.value);
  const cleanupLeaks = artifacts.filter((artifact) => artifact.record.type === "cleanup-run").flatMap((artifact) => array(artifact.value.resources).filter((resource) => isRecord(resource) && resource.status === "failed") as Values[]);
  // Both projections below read BOTH lanes (Phase 7, ADR-0010). A `test-result` is one Test Attempt the
  // runtime drove; a `test-result-batch` entry is one case a Runtime-Observed Execution reported, and
  // `deriveReleaseGateFromWorkspaceArtifacts` and `evaluateWorkspaceCoverage` already flatten an entry
  // into the same `CoverageAttempt` shape an attempt produces before handing it to `evaluateCoverage`,
  // which consumes already-flattened claims and flattens nothing itself. Filtering
  // `test-result` alone here — which is what this file did until the producer landed — made a run
  // credited entirely by a batch report "0 registered attempts evaluated" beside a READY gate, and hid
  // a skipped observed spec from `excludedNotRun` while `NOT_RUN` was exactly what its entry said.
  //
  // Unlike the coverage readers, neither projection gates on `creditsCoverage`: this is the REPORT, and
  // it describes what the run recorded rather than what earned credit. That matches the `test-result`
  // half, which has never filtered on provenance either.
  const observedEntries = artifacts.filter((artifact) => artifact.record.type === "test-result-batch")
    .flatMap((artifact) => array(artifact.value.entries).filter(isRecord).map((entry) => ({ record: artifact.record, entry })));
  const attemptCount = artifacts.filter((artifact) => artifact.record.type === "test-result").length + observedEntries.length;
  const excludedNotRun = [
    ...artifacts.filter((artifact) => artifact.record.type === "test-result" && artifact.value.status === "NOT_RUN").map((artifact) => str(artifact.value.testCaseId) ?? artifact.record.id),
    ...observedEntries.filter(({ entry }) => entry.status === "NOT_RUN").map(({ record, entry }) => str(entry.testCaseId) ?? str(entry.entryId) ?? record.id),
  ];
  const criticalFindings = currentOpenBugs.filter((bug) => bug.severity === "Blocker" || bug.severity === "Critical").map((bug) => bug.bugId);
  const remainingRisks = [...gateResult.ruleInputs.coverage.optionalGaps, ...currentOpenBugs.filter((bug) => bug.severity !== "Blocker" && bug.severity !== "Critical").map((bug) => bug.bugId), ...evidenceGaps.map((gap) => str(gap.reason) ?? "Evidence gap")];
  // `attemptId` is present only for attempt-subject evidence; an observed-execution finding reports its
  // evidence artifact without inventing an attempt it never had.
  const telemetryFindings = evidence.flatMap((artifact) => {
    const attemptId = evidenceAttemptId(artifact.value);
    return array(artifact.value.telemetryFindings).filter(isRecord).map((finding) => ({ ...finding, evidenceArtifactId: artifact.record.id, ...(attemptId === undefined ? {} : { attemptId }) }));
  });
  const model: QaReportModel = { artifactType: "qa-execution-report", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: input.workspace.runId, generatedAt: new Date().toISOString(), build: { identifier: build }, summary: `${attemptCount} registered attempts evaluated; ${currentOpenBugs.length} open product bug${currentOpenBugs.length === 1 ? "" : "s"}.`, coverageMethods: ["registered coverage obligations"], incidents, bugs, telemetryFindings, evidenceGaps, cleanupLeaks, criticalFindings, remainingRisks, excludedNotRun, protectedEnvironment: gateResult.protectedEnvironment, releaseGate: gateResult };
  const value = toQaExecutionReport(model);
  const report = await input.workspace.registerArtifactValue({ type: "qa-execution-report", value, relationships: [gate.id, ...artifacts.map((artifact) => artifact.record.id)], provenance: "runtime" });
  return { gate, report, json: renderCanonicalJson(model), markdown: renderMarkdown(model, input.locale ?? "en") };
}
