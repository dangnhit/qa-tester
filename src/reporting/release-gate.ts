import type { DefectSeverity } from "../defects/triage.js";
import { evaluateCoverage, type CoverageAttempt, type ResolvedCoverageObligation } from "../planning/coverage.js";

export type GateBug = Readonly<{ bugId: string; triageStatus: "NEEDS_TRIAGE" | "TRIAGED"; severity?: DefectSeverity; open: boolean }>;
export type ReleaseGateInput = Readonly<{
  artifactsValid: boolean;
  coverage: Readonly<{ requiredMissing: readonly string[]; optionalGaps: readonly string[]; requiredHighRisk: readonly { obligationId: string; passed: boolean }[] }>;
  bugs: readonly GateBug[];
  sharedBlockers: readonly string[];
}>;
export type RuleVerdict = Readonly<{ rule: string; passed: boolean; reason: string }>;
export type ReleaseGateResult = Readonly<{ recommendation: "READY" | "READY_WITH_RISKS" | "NOT_READY"; ruleInputs: ReleaseGateInput; verdicts: readonly RuleVerdict[] }>;
/** The gate's go/no-go verdict, reused wherever a caller surfaces it without recomputing the gate. */
export type ReleaseRecommendation = ReleaseGateResult["recommendation"];
export type GateSourceArtifact = Readonly<{ id: string; sha256: string; type: string }>;
export type DerivedReleaseGate = ReleaseGateResult & Readonly<{ sourceArtifacts: readonly GateSourceArtifact[] }>;
export type GateWorkspaceArtifact = Readonly<{
  record: GateSourceArtifact & Readonly<{ provenance?: string }>;
  value: Readonly<Record<string, unknown>>;
}>;

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function string(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
function canonical<T>(items: readonly T[], key: (item: T) => string): readonly T[] { return [...items].sort((left, right) => key(left).localeCompare(key(right))); }

/** Deterministic policy only: narrative code may describe this result but cannot alter it. */
export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateResult {
  const open = input.bugs.filter((bug) => bug.open);
  const untriaged = open.filter((bug) => bug.triageStatus === "NEEDS_TRIAGE");
  const blockers = open.filter((bug) => bug.triageStatus === "TRIAGED" && (bug.severity === "Blocker" || bug.severity === "Critical"));
  const nonCritical = open.filter((bug) => bug.triageStatus === "TRIAGED" && bug.severity !== "Blocker" && bug.severity !== "Critical");
  const highRiskMisses = input.coverage.requiredHighRisk.filter((obligation) => !obligation.passed);
  const verdicts: RuleVerdict[] = [
    { rule: "VALID_ARTIFACTS", passed: input.artifactsValid, reason: input.artifactsValid ? "All registered artifacts are valid." : "One or more registered artifacts are invalid." },
    { rule: "NO_SHARED_BLOCKERS", passed: input.sharedBlockers.length === 0, reason: input.sharedBlockers.length === 0 ? "No shared blockers are present." : `Shared blockers: ${input.sharedBlockers.join(", ")}.` },
    { rule: "NO_OPEN_BLOCKER_OR_CRITICAL", passed: blockers.length === 0, reason: blockers.length === 0 ? "No open Blocker or Critical product bug." : `Open Blocker/Critical bugs: ${blockers.map((bug) => bug.bugId).join(", ")}.` },
    { rule: "NO_UNTRIAGED_PRODUCT_BUG", passed: untriaged.length === 0, reason: untriaged.length === 0 ? "No open untriaged product bug." : `Open untriaged bugs: ${untriaged.map((bug) => bug.bugId).join(", ")}.` },
    { rule: "REQUIRED_HIGH_RISK_PASSED", passed: highRiskMisses.length === 0, reason: highRiskMisses.length === 0 ? "All required high-risk obligations passed." : `Required high-risk obligations not passing: ${highRiskMisses.map((item) => item.obligationId).join(", ")}.` },
    { rule: "REQUIRED_COVERAGE_COMPLETE", passed: input.coverage.requiredMissing.length === 0, reason: input.coverage.requiredMissing.length === 0 ? "All required coverage obligations are satisfied." : `Required coverage missing: ${input.coverage.requiredMissing.join(", ")}.` },
  ];
  const hardFailure = verdicts.some((verdict) => !verdict.passed);
  if (hardFailure) return { recommendation: "NOT_READY", ruleInputs: input, verdicts };
  const hasRisks = input.coverage.optionalGaps.length > 0 || nonCritical.length > 0;
  const completion: RuleVerdict = {
    rule: "NO_OPEN_PRODUCT_DEFECT_FOR_READY",
    passed: open.length === 0,
    reason: open.length === 0 ? "No open product defect remains." : `Open non-critical product bugs: ${nonCritical.map((bug) => bug.bugId).join(", ")}.`,
  };
  return { recommendation: hasRisks ? "READY_WITH_RISKS" : "READY", ruleInputs: input, verdicts: [...verdicts, completion] };
}

/** Binds the gate to the exact immutable source artifact records used to evaluate it. */
export function deriveReleaseGateFromArtifacts(input: Readonly<{
  artifactRecords: readonly GateSourceArtifact[];
  coverage: ReleaseGateInput["coverage"];
  bugs: readonly GateBug[];
  incidents: readonly unknown[];
  evidenceGaps: readonly unknown[];
  cleanupLeaks: readonly unknown[];
  sharedBlockers: readonly string[];
  artifactsValid: boolean;
}>): DerivedReleaseGate {
  const sourceArtifacts = [...input.artifactRecords].sort((left, right) => left.id.localeCompare(right.id));
  const result = evaluateReleaseGate({ artifactsValid: input.artifactsValid, coverage: input.coverage, bugs: input.bugs, sharedBlockers: input.sharedBlockers });
  return { ...result, sourceArtifacts };
}

/**
 * The complete, immutable workspace is the sole source for a gate.  This is
 * deliberately shared by generation, registration, and workspace opening so
 * a caller cannot omit a troublesome fact from a hand-built rule snapshot.
 */
export function deriveReleaseGateFromWorkspaceArtifacts(artifacts: readonly GateWorkspaceArtifact[], validationDiagnostics: readonly string[] = []): DerivedReleaseGate {
  // Workflow checkpoints are operational resumability metadata, not QA facts.
  // Including later revisions would retroactively invalidate an immutable gate.
  const source = artifacts.filter((artifact) => artifact.record.type !== "release-gate" && artifact.record.type !== "qa-execution-report" && artifact.record.type !== "workflow-checkpoint");
  const valuesOf = (type: string) => source.filter((artifact) => artifact.record.type === type);
  const cases = valuesOf("test-case");
  const obligations: ResolvedCoverageObligation[] = valuesOf("coverage-obligation").flatMap((artifact) => {
    const value = artifact.value; const viewport = value.viewport;
    const analysis = source.find((candidate) => candidate.record.id === value.requirementAnalysisArtifactId && candidate.record.type === "requirement-analysis");
    const authoritative = array(analysis?.value.statements).some((statement) => record(statement) && statement.requirementId === value.requirementId && statement.authority === "AUTHORITATIVE");
    if (!record(viewport) || typeof viewport.width !== "number" || typeof viewport.height !== "number") return [];
    const fields = [value.obligationId, value.requirementId, value.role, value.behavior, value.browser, value.risk, value.outcome];
    if (!fields.every((field) => string(field) !== undefined)) return [];
    return [{ obligationId: value.obligationId as string, requirementId: value.requirementId as string, role: value.role as string, behavior: value.behavior as string, browser: value.browser as string, viewport: { width: viewport.width, height: viewport.height }, accessibilityMethod: string(value.accessibilityMethod), risk: value.risk as string, required: value.required === true, outcome: value.outcome as string, authoritativeRequirement: authoritative }];
  });
  const attempts: CoverageAttempt[] = valuesOf("test-result").filter((artifact) => artifact.record.provenance === "runtime-execution").flatMap((artifact) => {
    const value = artifact.value;
    const testCase = cases.find((candidate) => candidate.value.testCaseId === value.testCaseId && candidate.value.revisionId === value.testCaseRevisionId && candidate.value.instanceId === value.testCaseInstanceId);
    const dimensions = testCase?.value.coverage;
    if (!record(dimensions) || !record(dimensions.viewport) || typeof dimensions.viewport.width !== "number" || typeof dimensions.viewport.height !== "number") return [];
    const fields = [value.attemptId, value.status, dimensions.requirementId, dimensions.role, dimensions.behavior, dimensions.browser, dimensions.risk, dimensions.outcome];
    if (!fields.every((field) => string(field) !== undefined)) return [];
    return [{ attemptId: value.attemptId as string, status: value.status as string, requirementId: dimensions.requirementId as string, role: dimensions.role as string, behavior: dimensions.behavior as string, browser: dimensions.browser as string, viewport: { width: dimensions.viewport.width, height: dimensions.viewport.height }, accessibilityMethod: string(dimensions.accessibilityMethod), risk: dimensions.risk as string, outcome: dimensions.outcome as string }];
  });
  const evaluation = evaluateCoverage(obligations, attempts);
  const passed = new Set(evaluation.satisfied);
  const highRisk = canonical(obligations.filter((obligation) => obligation.required && (obligation.risk === "high" || obligation.risk === "critical")).map((obligation) => ({ obligationId: obligation.obligationId, passed: passed.has(obligation.obligationId) })), (item) => item.obligationId);
  const optionalGaps = canonical(obligations.filter((obligation) => !obligation.required && !passed.has(obligation.obligationId)).map((obligation) => obligation.obligationId), (item) => item);
  const latestBugs = new Map<string, GateWorkspaceArtifact>();
  for (const artifact of valuesOf("bug-report")) {
    const bugId = string(artifact.value.bugId); if (!bugId) continue;
    const current = latestBugs.get(bugId);
    const revision = typeof artifact.value.revision === "number" ? artifact.value.revision : 1;
    const currentRevision = typeof current?.value.revision === "number" ? current.value.revision : 1;
    if (!current || revision > currentRevision) latestBugs.set(bugId, artifact);
  }
  const bugs: readonly GateBug[] = canonical([...latestBugs.values()].flatMap((artifact): GateBug[] => {
    const value = artifact.value; const bugId = string(value.bugId); const triageStatus = value.triageStatus;
    if (!bugId || (triageStatus !== "NEEDS_TRIAGE" && triageStatus !== "TRIAGED") || typeof value.open !== "boolean") return [];
    const severity = value.severity;
    return [{ bugId, triageStatus, ...(severity === "Blocker" || severity === "Critical" || severity === "Major" || severity === "Minor" || severity === "Trivial" ? { severity } : {}), open: value.open }];
  }), (item) => item.bugId);
  const incidents = canonical(valuesOf("incident").map((artifact) => artifact.value), (item) => String(item.incidentId));
  const evidenceGaps = canonical(valuesOf("evidence-gap").map((artifact) => artifact.value), (item) => String(item.evidenceGapId));
  const cleanupLeaks: readonly Record<string, unknown>[] = canonical(valuesOf("cleanup-run").flatMap((artifact) => array(artifact.value.resources).filter(record).filter((resource) => resource.status === "failed")), (item) => String(item.id));
  const unmappedChangeRisks = canonical(valuesOf("regression-selection").flatMap((artifact) => array(artifact.value.unmappedChangeRisks).filter(record)), (item) => String(item.changeId));
  const sharedBlockers = canonical([
    ...incidents.filter((incident) => incident.kind === "ENVIRONMENT_INCIDENT").map((incident) => `Environment incident ${String(incident.incidentId)}`),
    ...evidenceGaps.map((gap) => `Evidence gap ${String(gap.evidenceGapId)} affects ${String(gap.affectedClaim)}`),
    ...cleanupLeaks.map((leak) => `Cleanup leak ${String(leak.id)}`),
    ...unmappedChangeRisks.map((risk) => `Unmapped change risk ${String(risk.changeId)}`),
    ...validationDiagnostics.map((diagnostic) => `Validation diagnostic ${diagnostic}`),
  ], (item) => item);
  const ruleInputs = {
    artifactsValid: validationDiagnostics.length === 0,
    coverage: { requiredMissing: canonical(evaluation.missing, (item) => item), optionalGaps, requiredHighRisk: highRisk },
    bugs,
    sharedBlockers,
    incidents,
    evidenceGaps,
    cleanupLeaks,
    unmappedChangeRisks,
    validationDiagnostics: canonical(validationDiagnostics, (item) => item),
  };
  const result = evaluateReleaseGate(ruleInputs);
  return {
    ...result,
    // Keep every workspace fact in the persisted snapshot, including facts
    // that are not presently policy-blocking, so later policy changes remain
    // auditable and omissions are detectable.
    ruleInputs,
    sourceArtifacts: source
      .map((artifact) => ({ id: artifact.record.id, sha256: artifact.record.sha256, type: artifact.record.type }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}
