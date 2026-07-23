import { deriveReleaseGateFromWorkspaceArtifacts } from "../reporting/release-gate.js";
import { toQaExecutionReport, type QaReportModel } from "../reporting/report-model.js";
import { renderCanonicalJson } from "../reporting/render-json.js";
import { renderMarkdown } from "../reporting/render-markdown.js";
import type { ArtifactRecord, RunWorkspace } from "../core/run-workspace.js";

type Values = Readonly<Record<string, unknown>>;
function record(value: unknown): value is Values { return typeof value === "object" && value !== null && !Array.isArray(value); }
function str(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }

/** Generates both report projections from immutable registered artifacts, then registers canonical gate and report artifacts. */
export async function generateQaReport(input: Readonly<{ workspace: RunWorkspace; locale?: "en" | "vi" }>): Promise<Readonly<{ gate: ArtifactRecord; report: ArtifactRecord; json: string; markdown: string }>> {
  const artifacts = await input.workspace.readRegisteredArtifacts();
  if (artifacts.some((artifact) => artifact.record.type === "release-gate" || artifact.record.type === "qa-execution-report")) throw new Error("A release gate and QA report are immutable and may be generated once per run");
  const bugs = artifacts.filter((artifact) => artifact.record.type === "bug-report").map((artifact) => artifact.value);
  const gateResult = deriveReleaseGateFromWorkspaceArtifacts(artifacts.map((artifact) => ({
    record: { id: artifact.record.id, sha256: artifact.record.sha256, type: artifact.record.type }, value: artifact.value,
  })));
  const currentBugs = gateResult.ruleInputs.bugs;
  const currentOpenBugs = currentBugs.filter((bug) => bug.open);
  const gateValue = { artifactType: "release-gate", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: input.workspace.runId, ...gateResult };
  const gate = await input.workspace.registerArtifactValue({ type: "release-gate", value: gateValue, relationships: artifacts.map((artifact) => artifact.record.id), provenance: "runtime" });
  const evidence = artifacts.filter((artifact) => artifact.record.type === "evidence");
  const build = evidence.map((artifact) => record(artifact.value.provenance) ? str(artifact.value.provenance.build) : undefined).find((value) => value !== undefined) ?? "unknown";
  const incidents = artifacts.filter((artifact) => artifact.record.type === "incident").map((artifact) => artifact.value);
  const evidenceGaps = artifacts.filter((artifact) => artifact.record.type === "evidence-gap").map((artifact) => artifact.value);
  const cleanupLeaks = artifacts.filter((artifact) => artifact.record.type === "cleanup-run").flatMap((artifact) => array(artifact.value.resources).filter((resource) => record(resource) && resource.status === "failed") as Values[]);
  const excludedNotRun = artifacts.filter((artifact) => artifact.record.type === "test-result" && artifact.value.status === "NOT_RUN").map((artifact) => str(artifact.value.testCaseId) ?? artifact.record.id);
  const criticalFindings = currentOpenBugs.filter((bug) => bug.severity === "Blocker" || bug.severity === "Critical").map((bug) => bug.bugId);
  const remainingRisks = [...gateResult.ruleInputs.coverage.optionalGaps, ...currentOpenBugs.filter((bug) => bug.severity !== "Blocker" && bug.severity !== "Critical").map((bug) => bug.bugId), ...evidenceGaps.map((gap) => str(gap.reason) ?? "Evidence gap")];
  const telemetryFindings = evidence.flatMap((artifact) => array(artifact.value.telemetryFindings).filter(record).map((finding) => ({ ...finding, evidenceArtifactId: artifact.record.id, attemptId: artifact.value.attemptId })));
  const model: QaReportModel = { artifactType: "qa-execution-report", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: input.workspace.runId, generatedAt: new Date().toISOString(), build: { identifier: build }, summary: `${artifacts.filter((artifact) => artifact.record.type === "test-result").length} registered attempts evaluated; ${currentOpenBugs.length} open product bug${currentOpenBugs.length === 1 ? "" : "s"}.`, coverageMethods: ["registered coverage obligations"], incidents, bugs, telemetryFindings, evidenceGaps, cleanupLeaks, criticalFindings, remainingRisks, excludedNotRun, releaseGate: gateResult };
  const value = toQaExecutionReport(model);
  const report = await input.workspace.registerArtifactValue({ type: "qa-execution-report", value, relationships: [gate.id, ...artifacts.map((artifact) => artifact.record.id)], provenance: "runtime" });
  return { gate, report, json: renderCanonicalJson(model), markdown: renderMarkdown(model, input.locale ?? "en") };
}
