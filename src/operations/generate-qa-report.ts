import { deriveReleaseGateFromWorkspaceArtifacts, type GateBug } from "../reporting/release-gate.js";
import { evaluateCoverage, type CoverageAttempt, type ResolvedCoverageObligation } from "../planning/coverage.js";
import { toQaExecutionReport, type QaReportModel } from "../reporting/report-model.js";
import { renderCanonicalJson } from "../reporting/render-json.js";
import { renderMarkdown } from "../reporting/render-markdown.js";
import type { ArtifactRecord, RegisteredWorkspaceArtifact, RunWorkspace } from "../core/run-workspace.js";

type Values = Readonly<Record<string, unknown>>;
function record(value: unknown): value is Values { return typeof value === "object" && value !== null && !Array.isArray(value); }
function str(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
function coverageFrom(artifacts: readonly RegisteredWorkspaceArtifact[]): { evaluation: ReturnType<typeof evaluateCoverage>; highRisk: readonly { obligationId: string; passed: boolean }[]; optionalGaps: readonly string[] } {
  const cases = artifacts.filter((artifact) => artifact.record.type === "test-case");
  const obligations: ResolvedCoverageObligation[] = artifacts.filter((artifact) => artifact.record.type === "coverage-obligation").flatMap((artifact) => {
    const value = artifact.value;
    const viewport = value.viewport;
    if (!record(viewport) || typeof viewport.width !== "number" || typeof viewport.height !== "number") return [];
    const analysis = artifacts.find((candidate) => candidate.record.id === value.requirementAnalysisArtifactId && candidate.record.type === "requirement-analysis");
    const authoritative = array(analysis?.value.statements).some((statement) => record(statement) && statement.requirementId === value.requirementId && statement.authority === "AUTHORITATIVE");
    const needed = [value.obligationId, value.requirementId, value.role, value.behavior, value.browser, value.risk, value.outcome].every((item) => str(item) !== undefined);
    return !needed ? [] : [{ obligationId: value.obligationId as string, requirementId: value.requirementId as string, role: value.role as string, behavior: value.behavior as string, browser: value.browser as string, viewport: { width: viewport.width, height: viewport.height }, accessibilityMethod: str(value.accessibilityMethod), risk: value.risk as string, required: value.required === true, outcome: value.outcome as string, authoritativeRequirement: authoritative }];
  });
  const attempts: CoverageAttempt[] = artifacts.filter((artifact) => artifact.record.type === "test-result").flatMap((artifact) => {
    const match = cases.find((testCase) => testCase.value.testCaseId === artifact.value.testCaseId && testCase.value.revisionId === artifact.value.testCaseRevisionId && testCase.value.instanceId === artifact.value.testCaseInstanceId);
    const dimensions = match?.value.coverage;
    if (!record(dimensions) || !record(dimensions.viewport) || typeof dimensions.viewport.width !== "number" || typeof dimensions.viewport.height !== "number") return [];
    const needed = [artifact.value.attemptId, artifact.value.status, dimensions.requirementId, dimensions.role, dimensions.behavior, dimensions.browser, dimensions.risk, dimensions.outcome].every((item) => str(item) !== undefined);
    return !needed ? [] : [{ attemptId: artifact.value.attemptId as string, status: artifact.value.status as string, requirementId: dimensions.requirementId as string, role: dimensions.role as string, behavior: dimensions.behavior as string, browser: dimensions.browser as string, viewport: { width: dimensions.viewport.width, height: dimensions.viewport.height }, accessibilityMethod: str(dimensions.accessibilityMethod), risk: dimensions.risk as string, outcome: dimensions.outcome as string }];
  });
  const evaluation = evaluateCoverage(obligations, attempts);
  const passed = new Set(evaluation.satisfied);
  const highRisk = obligations.filter((obligation) => obligation.required && (obligation.risk === "high" || obligation.risk === "critical")).map((obligation) => ({ obligationId: obligation.obligationId, passed: passed.has(obligation.obligationId) }));
  const optionalGaps = obligations.filter((obligation) => !obligation.required && !passed.has(obligation.obligationId)).map((obligation) => obligation.obligationId);
  return { evaluation, highRisk, optionalGaps };
}
function asGateBug(value: Values): GateBug | undefined {
  const bugId = str(value.bugId); const triageStatus = value.triageStatus;
  if (!bugId || (triageStatus !== "NEEDS_TRIAGE" && triageStatus !== "TRIAGED") || typeof value.open !== "boolean") return undefined;
  const severity = value.severity;
  return { bugId, triageStatus, ...(severity === "Blocker" || severity === "Critical" || severity === "Major" || severity === "Minor" || severity === "Trivial" ? { severity } : {}), open: value.open };
}

/** Generates both report projections from immutable registered artifacts, then registers canonical gate and report artifacts. */
export async function generateQaReport(input: Readonly<{ workspace: RunWorkspace; locale?: "en" | "vi" }>): Promise<Readonly<{ gate: ArtifactRecord; report: ArtifactRecord; json: string; markdown: string }>> {
  const artifacts = await input.workspace.readRegisteredArtifacts();
  if (artifacts.some((artifact) => artifact.record.type === "release-gate" || artifact.record.type === "qa-execution-report")) throw new Error("A release gate and QA report are immutable and may be generated once per run");
  const coverage = coverageFrom(artifacts);
  const bugs = artifacts.filter((artifact) => artifact.record.type === "bug-report").map((artifact) => artifact.value);
  const gateBugs = bugs.map(asGateBug).filter((bug): bug is GateBug => bug !== undefined);
  const gateResult = deriveReleaseGateFromWorkspaceArtifacts(artifacts.map((artifact) => ({
    record: { id: artifact.record.id, sha256: artifact.record.sha256, type: artifact.record.type }, value: artifact.value,
  })));
  const gateValue = { artifactType: "release-gate", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: input.workspace.runId, ...gateResult };
  const gate = await input.workspace.registerArtifactValue({ type: "release-gate", value: gateValue, relationships: artifacts.map((artifact) => artifact.record.id), provenance: "runtime" });
  const evidence = artifacts.filter((artifact) => artifact.record.type === "evidence");
  const build = evidence.map((artifact) => record(artifact.value.provenance) ? str(artifact.value.provenance.build) : undefined).find((value) => value !== undefined) ?? "unknown";
  const incidents = artifacts.filter((artifact) => artifact.record.type === "incident").map((artifact) => artifact.value);
  const evidenceGaps = artifacts.filter((artifact) => artifact.record.type === "evidence-gap").map((artifact) => artifact.value);
  const cleanupLeaks = artifacts.filter((artifact) => artifact.record.type === "cleanup-run").flatMap((artifact) => array(artifact.value.resources).filter((resource) => record(resource) && resource.status === "failed") as Values[]);
  const excludedNotRun = artifacts.filter((artifact) => artifact.record.type === "test-result" && artifact.value.status === "NOT_RUN").map((artifact) => str(artifact.value.testCaseId) ?? artifact.record.id);
  const criticalFindings = gateBugs.filter((bug) => bug.open && (bug.severity === "Blocker" || bug.severity === "Critical")).map((bug) => bug.bugId);
  const remainingRisks = [...coverage.optionalGaps, ...gateBugs.filter((bug) => bug.open && bug.severity !== "Blocker" && bug.severity !== "Critical").map((bug) => bug.bugId), ...evidenceGaps.map((gap) => str(gap.reason) ?? "Evidence gap")];
  const telemetryFindings = evidence.flatMap((artifact) => array(artifact.value.telemetryFindings).filter(record).map((finding) => ({ ...finding, evidenceArtifactId: artifact.record.id, attemptId: artifact.value.attemptId })));
  const model: QaReportModel = { artifactType: "qa-execution-report", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: input.workspace.runId, generatedAt: new Date().toISOString(), build: { identifier: build }, summary: `${artifacts.filter((artifact) => artifact.record.type === "test-result").length} registered attempts evaluated.`, coverageMethods: ["registered coverage obligations"], incidents, bugs, telemetryFindings, evidenceGaps, cleanupLeaks, criticalFindings, remainingRisks, excludedNotRun, releaseGate: gateResult };
  const value = toQaExecutionReport(model);
  const report = await input.workspace.registerArtifactValue({ type: "qa-execution-report", value, relationships: [gate.id, ...artifacts.map((artifact) => artifact.record.id)], provenance: "runtime" });
  return { gate, report, json: renderCanonicalJson(model), markdown: renderMarkdown(model, input.locale ?? "en") };
}
