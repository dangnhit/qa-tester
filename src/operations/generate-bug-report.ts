import { createBugCandidate, type DefectAttempt } from "../defects/eligibility.js";
import { createRunScopedBugId, createBugFingerprint } from "../defects/fingerprint.js";
import { createIncidentFromAttempt } from "../defects/incidents.js";
import { evaluateReproduction } from "../defects/reproduction.js";
import { createTriage, type TriageInput } from "../defects/triage.js";
import { evidenceAttemptId } from "../core/artifact-record.js";
import { QaSkillsError } from "../core/errors.js";
import { createEntityId } from "../core/ids.js";
import { RunWorkspace, type ArtifactRecord, type RegisteredWorkspaceArtifact } from "../core/run-workspace.js";
import { isRecord } from "../core/values.js";

type Values = Readonly<Record<string, unknown>>;
type GeneratedDefect = Readonly<{ kind: "BUG"; record: ArtifactRecord }> | Readonly<{ kind: "INCIDENT"; record: ArtifactRecord }>;

function string(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0) throw new QaSkillsError(`Registered ${label} is invalid`, "ARTIFACT_BINDING"); return value; }
function attemptFrom(artifact: RegisteredWorkspaceArtifact): DefectAttempt & { testCaseRevisionId: string; testCaseInstanceId: string } {
  return { attemptId: string(artifact.value.attemptId, "attempt ID"), runId: string(artifact.value.runId, "attempt run ID"), testCaseId: string(artifact.value.testCaseId, "attempt testcase ID"), testCaseRevisionId: string(artifact.value.testCaseRevisionId, "attempt testcase revision ID"), testCaseInstanceId: string(artifact.value.testCaseInstanceId, "attempt testcase instance ID"), status: string(artifact.value.status, "attempt status"), failureClassification: string(artifact.value.failureClassification, "attempt failure classification") };
}
function environmentFrom(artifacts: readonly RegisteredWorkspaceArtifact[]): Values {
  const environment = artifacts.filter((artifact) => artifact.record.type === "environment-profile");
  if (environment.length !== 1 || !environment[0]) throw new QaSkillsError("Bug generation requires one registered environment", "ARTIFACT_BINDING");
  const value = environment[0].value;
  return { environmentProfileId: string(value.environmentProfileId, "environment profile ID"), name: string(value.name, "environment name"), classification: string(value.classification, "environment classification"), baseUrl: string(value.baseUrl, "environment base URL") };
}
function expectedFrom(artifacts: readonly RegisteredWorkspaceArtifact[], attempt: DefectAttempt & { testCaseRevisionId: string; testCaseInstanceId: string }): string {
  const testCase = artifacts.find((artifact) => artifact.record.type === "test-case" && artifact.value.testCaseId === attempt.testCaseId && artifact.value.revisionId === attempt.testCaseRevisionId && artifact.value.instanceId === attempt.testCaseInstanceId);
  if (!testCase) throw new QaSkillsError("Bug generation requires the registered testcase for the attempt", "ARTIFACT_BINDING");
  const approvedPlanCase = artifacts.filter((artifact) => artifact.record.type === "test-plan" && isRecord(artifact.value.approvalDecision) && artifact.value.approvalDecision.approved === true)
    .flatMap((artifact) => Array.isArray(artifact.value.testCases) ? artifact.value.testCases.filter(isRecord).filter((candidate) => candidate.testCaseId === attempt.testCaseId && (!isRecord(candidate.browserExecution) || candidate.browserExecution.revisionId === attempt.testCaseRevisionId)) : [])
    .find((candidate) => Array.isArray(candidate.expectedResults));
  const plannedExpected = approvedPlanCase && Array.isArray(approvedPlanCase.expectedResults)
    ? approvedPlanCase.expectedResults.filter(isRecord).filter((result) => typeof result.text === "string" && result.text.length > 0).map((result) => result.text).join(" ") : undefined;
  if (plannedExpected) return plannedExpected;
  const coverage = testCase.value.coverage;
  return isRecord(coverage) && typeof coverage.outcome === "string" && coverage.outcome.length > 0
    ? coverage.outcome : string(testCase.value.title, "testcase title");
}
function evidenceFor(artifacts: readonly RegisteredWorkspaceArtifact[], attemptIds: readonly string[]): readonly RegisteredWorkspaceArtifact[] {
  return artifacts.filter((artifact) => {
    const attemptId = artifact.record.type === "evidence" ? evidenceAttemptId(artifact.value) : undefined;
    return attemptId !== undefined && attemptIds.includes(attemptId);
  });
}
function observedActualFrom(artifacts: readonly RegisteredWorkspaceArtifact[], attemptIds: readonly string[]): { actual: string; unknown: boolean } {
  const step = artifacts.find((artifact) => artifact.record.type === "test-step-result" && typeof artifact.value.attemptId === "string" && attemptIds.includes(artifact.value.attemptId) && (typeof artifact.value.observedActual === "string" || typeof artifact.value.error === "string"));
  if (step) return { actual: (typeof step.value.observedActual === "string" ? step.value.observedActual : step.value.error) as string, unknown: false };
  const findings: unknown[] = [];
  for (const artifact of evidenceFor(artifacts, attemptIds)) {
    if (Array.isArray(artifact.value.telemetryFindings)) {
      for (const finding of artifact.value.telemetryFindings as unknown[]) findings.push(finding);
    }
  }
  const telemetry = findings.find((finding) => isRecord(finding) && typeof finding.message === "string");
  if (isRecord(telemetry) && typeof telemetry.message === "string") return { actual: telemetry.message, unknown: false };
  return { actual: "Unknown observed actual (no registered step, error, or telemetry observation).", unknown: true };
}

/**
 * Generates only from revalidated workspace artifacts. The optional triage is an
 * impact assessment, never a substitute for an attempt, classification, or evidence claim.
 */
export async function generateBugReport(input: Readonly<{
  workspace: RunWorkspace;
  attemptId: string;
  reproductionAttemptIds?: readonly string[];
  unsafeRerunReason?: string;
  triage?: TriageInput;
  comparisonBugArtifacts?: readonly { runId: string; artifactId: string; sha256: string }[];
}>): Promise<GeneratedDefect> {
  const artifacts = await input.workspace.readRegisteredArtifacts();
  const attemptArtifact = artifacts.find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === input.attemptId);
  if (!attemptArtifact) throw new QaSkillsError("Bug generation requires a registered attempt ID", "ARTIFACT_BINDING");
  const original = attemptFrom(attemptArtifact);
  const candidate = createBugCandidate(original);
  const incident = createIncidentFromAttempt(original);
  const environment = environmentFrom(artifacts);
  const scannedIds = artifacts.filter((artifact) => artifact.record.type === "test-result" && artifact.value.testCaseId === original.testCaseId).map((artifact) => string(artifact.value.attemptId, "attempt ID"));
  const selectedIds = input.reproductionAttemptIds === undefined ? [original.attemptId, ...scannedIds.filter((id) => id !== original.attemptId)] : [...input.reproductionAttemptIds];
  if (selectedIds[0] !== original.attemptId || new Set(selectedIds).size !== selectedIds.length) throw new QaSkillsError("Reproduction must begin with the registered original attempt and contain distinct IDs", "ARTIFACT_BINDING");
  const selectedArtifacts = selectedIds.map((attemptId) => artifacts.find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === attemptId));
  if (selectedArtifacts.some((artifact) => !artifact)) throw new QaSkillsError("Reproduction includes an unregistered attempt", "ARTIFACT_BINDING");
  const selected = selectedArtifacts.map((artifact) => attemptFrom(artifact as RegisteredWorkspaceArtifact));
  if (!selected.every((attempt) => attempt.testCaseId === original.testCaseId)) throw new QaSkillsError("Reproduction attempts must use the original testcase", "ARTIFACT_BINDING");

  if (candidate === null) {
    if (incident === null) throw new QaSkillsError("Only non-passing classified attempts can generate a defect artifact", "ARTIFACT_BINDING");
    const evidence = evidenceFor(artifacts, [original.attemptId]);
    const gaps = artifacts.filter((artifact) => artifact.record.type === "evidence-gap" && artifact.value.attemptId === original.attemptId && artifact.value.runId === original.runId);
    if (evidence.length === 0 && gaps.length === 0) throw new QaSkillsError("Incident generation requires registered evidence or an evidence gap for its attempt", "ARTIFACT_BINDING");
    const value = {
      artifactType: "incident", schemaVersion: "1.0.0", producerVersion: "0.1.0", incidentId: `INC-${createEntityId()}`,
      runId: original.runId, attemptId: original.attemptId, kind: incident.kind,
      summary: `${incident.kind} observed for ${original.testCaseId}.`, environment,
      ...(evidence.length > 0 ? { evidenceIds: evidence.map((item) => string(item.value.evidenceId, "evidence ID")) } : {}),
      ...(gaps.length > 0 ? { evidenceGapIds: gaps.map((item) => string(item.value.evidenceGapId, "evidence gap ID")) } : {}), affectedAreas: [original.testCaseId],
      openQuestions: incident.kind === "INVESTIGATION_FINDING" ? ["Failure classification remains undetermined."] : [],
      provenance: { sourceAttemptId: original.attemptId },
    };
    const registered = await input.workspace.registerArtifactValue({ type: "incident", value, relationships: [attemptArtifact.record.id, ...evidence.map((item) => item.record.id), ...gaps.map((item) => item.record.id)], provenance: "runtime" });
    return { kind: "INCIDENT", record: registered };
  }

  const reproduction = evaluateReproduction(selected, input.unsafeRerunReason === undefined ? {} : { unsafeRerunReason: input.unsafeRerunReason });
  const evidence = evidenceFor(artifacts, reproduction.attemptIds);
  if (evidence.length === 0) throw new QaSkillsError("Product bug generation requires registered evidence from the reproduction set", "ARTIFACT_BINDING");
  const expected = expectedFrom(artifacts, original);
  const observation = observedActualFrom(artifacts, reproduction.attemptIds);
  const actual = observation.actual;
  const triage = createTriage(input.triage ?? { status: "NEEDS_TRIAGE", openQuestions: ["Assess user impact and remediation urgency."] });
  const existing = artifacts.filter((artifact) => artifact.record.type === "bug-report");
  if (existing.some((artifact) => artifact.value.attemptId === original.attemptId)) throw new QaSkillsError("A canonical bug already exists for the original attempt", "DUPLICATE_ARTIFACT");
  const feature = original.testCaseId;
  const fingerprint = createBugFingerprint({ feature, expected, actual, affectedAreas: [original.testCaseId] });
  const priorRevisions = existing.filter((artifact) => artifact.value.fingerprint === fingerprint).sort((left, right) => {
    const leftRevision = typeof left.value.revision === "number" ? left.value.revision : 1;
    const rightRevision = typeof right.value.revision === "number" ? right.value.revision : 1;
    return rightRevision - leftRevision;
  });
  const superseded = priorRevisions[0];
  const possibleDuplicateSources = await Promise.all((input.comparisonBugArtifacts ?? []).map(async (hint) => {
    if (hint.runId === input.workspace.runId) throw new QaSkillsError("Cross-run duplicate comparison must name a distinct run", "ARTIFACT_BINDING");
    const comparison = await RunWorkspace.open(input.workspace.root, hint.runId);
    try {
      const artifact = (await comparison.readRegisteredArtifacts()).find((candidate) => candidate.record.id === hint.artifactId && candidate.record.type === "bug-report");
      const record = await comparison.readArtifactRecord(hint.artifactId);
      if (!artifact || record.sha256 !== hint.sha256 || artifact.value.fingerprint !== fingerprint || typeof artifact.value.bugId !== "string") throw new QaSkillsError("Comparison bug artifact is not a trusted checksum-bound same-fingerprint possible duplicate", "ARTIFACT_BINDING");
      return { runId: hint.runId, artifactId: hint.artifactId, bugId: artifact.value.bugId, fingerprint, sha256: record.sha256 };
    } finally { await comparison.close(); }
  }));
  const mergedAttemptIds = [...new Set([...reproduction.attemptIds, ...(isRecord(superseded?.value.provenance) && Array.isArray(superseded.value.provenance.sourceAttemptIds) ? superseded.value.provenance.sourceAttemptIds.filter((id): id is string => typeof id === "string") : [])])];
  const mergedEvidence = [...new Set([...(Array.isArray(superseded?.value.evidenceIds) ? superseded.value.evidenceIds.filter((id): id is string => typeof id === "string") : []), ...evidence.map((item) => string(item.value.evidenceId, "evidence ID"))])];
  const mergedEvidenceArtifacts = [...new Set([...(isRecord(superseded?.value.provenance) && Array.isArray(superseded.value.provenance.evidenceArtifactIds) ? superseded.value.provenance.evidenceArtifactIds.filter((id): id is string => typeof id === "string") : []), ...evidence.map((item) => item.record.id)])];
  const mergedAttemptArtifacts = mergedAttemptIds.map((attemptId) => artifacts.find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === attemptId)).filter((artifact): artifact is RegisteredWorkspaceArtifact => artifact !== undefined);
  const mergedReproduction = evaluateReproduction(mergedAttemptArtifacts.map(attemptFrom), mergedAttemptIds.length === 1 && input.unsafeRerunReason !== undefined ? { unsafeRerunReason: input.unsafeRerunReason } : {});
  const value = {
    artifactType: "bug-report", schemaVersion: "1.0.0", producerVersion: "0.1.0",
    bugId: superseded ? string(superseded.value.bugId, "prior bug ID") : createRunScopedBugId(feature, original.runId, new Set(existing.map((artifact) => String(artifact.value.bugId))).size + 1), runId: original.runId, attemptId: original.attemptId,
    ...triage, testPriority: triage.triageStatus === "TRIAGED" ? triage.testPriority : "medium",
    expected, actual, environment, reproduction: mergedReproduction,
    evidenceIds: mergedEvidence, affectedAreas: [original.testCaseId],
    openQuestions: [...triage.openQuestions, ...(observation.unknown ? ["No registered observable actual was available."] : [])], provenance: { sourceAttemptIds: mergedAttemptIds, evidenceArtifactIds: mergedEvidenceArtifacts },
    fingerprint, possibleDuplicateSources, open: true,
    revision: superseded ? (typeof superseded.value.revision === "number" ? superseded.value.revision : 1) + 1 : 1,
    ...(superseded ? { supersedesArtifactId: superseded.record.id } : {}),
  };
  const registered = await input.workspace.registerArtifactValue({ type: "bug-report", value, relationships: [attemptArtifact.record.id, ...mergedAttemptArtifacts.map((item) => item.record.id), ...mergedEvidenceArtifacts, ...(superseded ? [superseded.record.id] : [])], provenance: "runtime" });
  return { kind: "BUG", record: registered };
}
