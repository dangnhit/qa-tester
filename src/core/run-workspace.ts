import { mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { parseAuthoringDocument } from "../contracts/authoring.js";
import { artifactTypes, type ArtifactType, type RunStatus } from "../contracts/types.js";
import { validateArtifact } from "../contracts/validator.js";
import { createBugFingerprint, createRunScopedBugId } from "../defects/fingerprint.js";
import { evaluateReproduction } from "../defects/reproduction.js";
import { deriveRegressionOutcome, deriveRetestVerdict } from "../retest/verdict.js";
import { regressionCaseFromCanonical } from "../regression/change-scope.js";
import { selectRegressionCases } from "../regression/selector.js";
import { deriveReleaseGateFromWorkspaceArtifacts } from "../reporting/release-gate.js";
import { deriveTestPlanApproval, type ApprovalDecision, type ApprovalEnvironment } from "../planning/approval.js";
import { assertRequirementAuthorities } from "../planning/authority.js";
import {
  artifactProfileNames,
  artifactProfileVersion,
  assertArtifactProfileName,
  evaluateArtifactProfile,
  type ArtifactProfileName,
} from "./artifact-profiles.js";
import { sha256, sha256Bytes, sha256Text } from "./checksum.js";
import { QaSkillsError } from "./errors.js";
import { assertPathWithin, assertRealpathWithin, atomicWriteFile, resolveWithin } from "./fs.js";
import { createEntityId, createRunId } from "./ids.js";
import { acquireRunLock, type RunLock } from "./run-lock.js";
import { utcNow } from "./time.js";

export type ArtifactRecord = {
  id: string;
  type: ArtifactType;
  relativePath: string;
  sha256: string;
  mediaType?: string;
  captureType?: "screenshot" | "trace" | "console" | "network" | "log";
  dimensions?: { width: number; height: number };
  provenance: string;
  relationships: string[];
};

type WorkspaceMetadata = {
  artifactType: "run-metadata";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  status: RunStatus;
  createdAt: string;
  mode: ArtifactProfileName;
  environmentProfileId: string;
  finalizedProfile?: { name: ArtifactProfileName; version: typeof artifactProfileVersion };
  linkedRunId?: string;
};

type Manifest = {
  artifactType: "artifact-manifest";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  artifacts: ArtifactRecord[];
};

type LoadedArtifact = {
  record: ArtifactRecord;
  value?: Record<string, unknown>;
  valid: boolean;
};

export type WorkspaceDiagnostic = { code: string; message: string; relativePath?: string };
export type WorkspaceValidation = { valid: boolean; diagnostics: WorkspaceDiagnostic[] };
export type RegisteredWorkspaceArtifact = Readonly<{ record: ArtifactRecord; value: Readonly<Record<string, unknown>> }>;
export type WorkspacePersistence = {
  writeAtomic(root: string, path: string, contents: string | Uint8Array): Promise<void>;
};
export type ExplicitTerminalOutcome = Extract<RunStatus, "COMPLETED_WITH_FAILURES" | "BLOCKED" | "ABORTED">;

const defaultPersistence: WorkspacePersistence = { writeAtomic: atomicWriteFile };
const terminalStatuses = new Set<RunStatus>(["COMPLETED", "COMPLETED_WITH_FAILURES", "BLOCKED", "ABORTED"]);
const nextStatuses: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  CREATED: ["RUNNING"],
  RUNNING: ["FINALIZING"],
  FINALIZING: ["COMPLETED", "COMPLETED_WITH_FAILURES", "BLOCKED", "ABORTED"],
  COMPLETED: [],
  COMPLETED_WITH_FAILURES: [],
  BLOCKED: [],
  ABORTED: [],
};

function isArtifactType(value: string): value is ArtifactType {
  return (artifactTypes as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value as unknown[] : []; }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sameResourceIdentity(left: unknown, right: unknown): boolean {
  return isRecord(left) && isRecord(right)
    && left.id === right.id && left.ownerRunId === right.ownerRunId && left.cleanupAction === right.cleanupAction;
}

function uniqueResourceIds(resources: unknown): resources is Record<string, unknown>[] {
  return Array.isArray(resources)
    && resources.every(isRecord)
    && new Set(resources.map((resource) => resource.id)).size === resources.length;
}

/** Reopens source evidence by explicit ID and checksum, making a cleanup artifact independently auditable. */
async function assertCleanupProvenance(cleanupPath: string, value: Record<string, unknown>): Promise<void> {
  const sourceRunId = value.sourceRunId;
  const artifactId = value.sourceTestDataManifestArtifactId;
  const expectedSha = value.sourceTestDataManifestSha256;
  const snapshot = value.sourceTestDataManifest;
  const cleanupResources = value.resources;
  if (typeof sourceRunId !== "string" || typeof artifactId !== "string" || typeof expectedSha !== "string" || !isRecord(snapshot) || !Array.isArray(cleanupResources)) throw new Error("Cleanup provenance is incomplete");
  const root = dirname(dirname(cleanupPath));
  const sourcePath = await assertRealpathWithin(root, join("qa-results", sourceRunId));
  const sourceMetadata = JSON.parse(await readFile(await assertRealpathWithin(sourcePath, "run-metadata.json"), "utf8")) as unknown;
  if (!validateArtifact("run-metadata", sourceMetadata).valid || !isRecord(sourceMetadata) || !terminalStatuses.has(sourceMetadata.status as RunStatus)) throw new Error("Cleanup source run must be immutable and terminal");
  const sourceManifest = JSON.parse(await readFile(await assertRealpathWithin(sourcePath, "artifact-manifest.json"), "utf8")) as Manifest;
  if (!validateArtifact("artifact-manifest", sourceManifest).valid || sourceManifest.runId !== sourceRunId) throw new Error("Cleanup source manifest is invalid");
  const sourceRecord = sourceManifest.artifacts.find((record) => record.id === artifactId && record.type === "test-data-manifest");
  if (!sourceRecord || sourceRecord.sha256 !== expectedSha) throw new Error("Cleanup source test-data artifact ID or checksum is invalid");
  const sourceArtifactPath = await assertRealpathWithin(sourcePath, sourceRecord.relativePath);
  if (await sha256(sourceArtifactPath) !== expectedSha) throw new Error("Cleanup source test-data artifact checksum no longer matches");
  const sourceValue = JSON.parse(await readFile(sourceArtifactPath, "utf8")) as unknown;
  if (!validateArtifact("test-data-manifest", sourceValue).valid || !isRecord(sourceValue) || sourceValue.runId !== sourceRunId) throw new Error("Cleanup source test-data artifact is invalid");
  if (JSON.stringify(sourceValue) !== JSON.stringify(snapshot)) throw new Error("Cleanup source snapshot does not equal the immutable source artifact");
  const sourceResources = sourceValue.resources;
  if (!uniqueResourceIds(sourceResources) || !uniqueResourceIds(cleanupResources) || sourceResources.length !== cleanupResources.length || !sourceResources.every((resource) => cleanupResources.some((candidate) => sameResourceIdentity(resource, candidate)))) throw new Error("Cleanup resources do not exactly match source resource ownership");
}

function matchingDimensions(value: unknown, dimensions: { width: number; height: number }): boolean {
  return isRecord(value) && value.width === dimensions.width && value.height === dimensions.height;
}

function matchesEvidencePrimary(value: Record<string, unknown>, primary: ArtifactRecord): boolean {
  const provenance = value.provenance;
  return value.sha256 === primary.sha256
    && value.relativePath === primary.relativePath
    && value.mediaType === primary.mediaType
    && value.kind === primary.captureType
    && isRecord(provenance)
    && provenance.captureType === primary.captureType
    && (primary.dimensions === undefined || matchingDimensions(provenance.dimensions, primary.dimensions));
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function addDiagnostic(
  diagnostics: WorkspaceDiagnostic[],
  diagnostic: WorkspaceDiagnostic,
): void {
  if (!diagnostics.some((candidate) =>
    candidate.code === diagnostic.code
    && candidate.relativePath === diagnostic.relativePath
    && candidate.message === diagnostic.message
  )) diagnostics.push(diagnostic);
}

function invalidate(
  artifact: LoadedArtifact,
  diagnostics: WorkspaceDiagnostic[],
  code: string,
  message: string,
): boolean {
  addDiagnostic(diagnostics, { code, message, relativePath: artifact.record.relativePath });
  if (!artifact.valid) return false;
  artifact.valid = false;
  return true;
}

function assertPersistedPlanningSemantics(artifact: LoadedArtifact, artifacts: readonly LoadedArtifact[]): void {
  const value = artifact.value;
  if (!value) return;
  if (artifact.record.type === "requirement-analysis") {
    assertRequirementAuthorities(value);
    return;
  }
  if (artifact.record.type === "coverage-obligation") {
    if (typeof value.requirementId !== "string" || typeof value.requirementAnalysisArtifactId !== "string") {
      throw new Error("Coverage obligation requirement binding is invalid");
    }
    const source = artifacts.find((candidate) => candidate.valid
      && candidate.record.id === value.requirementAnalysisArtifactId
      && candidate.record.type === "requirement-analysis");
    const statements = source?.value?.statements;
    if (!Array.isArray(statements) || statements.filter((statement) => isRecord(statement) && statement.requirementId === value.requirementId).length !== 1) {
      throw new Error("Coverage obligation references an orphan or ambiguous requirement");
    }
    return;
  }
  if (artifact.record.type !== "test-plan") return;
  const environments = artifacts.filter((candidate) => candidate.valid && candidate.record.type === "environment-profile");
  const classification = environments.length === 1 ? environments[0]?.value?.classification : undefined;
  if (typeof classification !== "string") throw new Error("Test plan requires one authoritative environment profile");
  const decision = deriveTestPlanApproval({
    plan: value,
    requirementAnalyses: artifacts.filter((candidate): candidate is LoadedArtifact & { value: Record<string, unknown> } => candidate.valid && candidate.record.type === "requirement-analysis" && candidate.value !== undefined).map((candidate) => candidate.value),
    environment: { classification } as ApprovalEnvironment,
  });
  if (JSON.stringify(value.approvalDecision) !== JSON.stringify(decision)) throw new Error("Persisted test plan approval decision does not equal the derived decision");
}

async function filesUnder(root: string, directory: string): Promise<string[]> {
  await assertPathWithin(root, directory);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry);
    await assertPathWithin(root, path);
    if ((await stat(path)).isDirectory()) return filesUnder(root, path);
    return [path];
  }));
  return files.flat();
}

async function inspectWorkspaceState(
  path: string,
  expectedRunId: string,
): Promise<{
  metadata: WorkspaceMetadata;
  manifest: Manifest;
  artifacts: LoadedArtifact[];
  diagnostics: WorkspaceDiagnostic[];
}> {
  const metadataPath = await assertRealpathWithin(path, "run-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as WorkspaceMetadata;
  if (!validateArtifact("run-metadata", metadata).valid) {
    throw new QaSkillsError("Invalid workspace metadata or finalized profile/mode binding", "INVALID_ARTIFACT");
  }
  if (metadata.runId !== expectedRunId) {
    throw new QaSkillsError("Metadata run ID does not match the requested workspace", "ARTIFACT_BINDING");
  }

  const manifestPath = await assertRealpathWithin(path, "artifact-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  if (!validateArtifact("artifact-manifest", manifest).valid) {
    throw new QaSkillsError("Invalid artifact manifest", "INVALID_MANIFEST");
  }
  if (manifest.runId !== expectedRunId) {
    throw new QaSkillsError("Manifest run ID does not match the requested workspace", "ARTIFACT_BINDING");
  }

  const diagnostics: WorkspaceDiagnostic[] = [];
  const knownIds = new Set(manifest.artifacts.map((artifact) => artifact.id));
  const duplicateIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (seenIds.has(artifact.id)) duplicateIds.add(artifact.id);
    seenIds.add(artifact.id);
    for (const relationship of artifact.relationships) {
      if (!knownIds.has(relationship)) {
        addDiagnostic(diagnostics, {
          code: "UNKNOWN_RELATIONSHIP",
          message: `Relationship ${relationship} is not registered in this workspace`,
          relativePath: artifact.relativePath,
        });
      }
    }
  }

  const artifacts = await Promise.all(manifest.artifacts.map(async (record): Promise<LoadedArtifact> => {
    const loaded: LoadedArtifact = { record, valid: true };
    if (duplicateIds.has(record.id)) {
      invalidate(loaded, diagnostics, "DUPLICATE_ARTIFACT_ID", `Manifest artifact ID ${record.id} is ambiguous`);
    }
    let absolutePath: string;
    try {
      absolutePath = await assertRealpathWithin(path, record.relativePath);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") {
        invalidate(loaded, diagnostics, "MISSING_FILE", `Missing registered file ${record.relativePath}`);
        return loaded;
      }
      throw error;
    }
    if (await sha256(absolutePath) !== record.sha256) {
      invalidate(loaded, diagnostics, "CHECKSUM_MISMATCH", `Checksum mismatch for ${record.relativePath}`);
      return loaded;
    }
    if (record.mediaType !== undefined) return loaded;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
    } catch {
      invalidate(loaded, diagnostics, "ARTIFACT_TYPE_MISMATCH", `Registered ${record.type} payload is not valid JSON`);
      return loaded;
    }
    if (!isRecord(value) || !validateArtifact(record.type, value).valid) {
      invalidate(loaded, diagnostics, "ARTIFACT_TYPE_MISMATCH", `Payload does not match declared artifact type ${record.type}`);
      return loaded;
    }
    loaded.value = value;
    return loaded;
  }));

  for (const artifact of artifacts) {
    if (artifact.record.relationships.some((relationship) => !knownIds.has(relationship))) artifact.valid = false;
    const value = artifact.value;
    if (!value || !artifact.valid) continue;
    if (Object.hasOwn(value, "runId") && value.runId !== expectedRunId) {
      invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Artifact run ID does not match this workspace");
    }
    if (Object.hasOwn(value, "environmentProfileId") && value.environmentProfileId !== metadata.environmentProfileId) {
      invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Artifact environment profile ID does not match this workspace");
    }
  }

  const environmentArtifacts = artifacts.filter((artifact) => artifact.record.type === "environment-profile");
  if (environmentArtifacts.length !== 1) {
    throw new QaSkillsError("Workspace must have one authoritative environment profile", "ARTIFACT_BINDING");
  }
  const environmentArtifact = environmentArtifacts[0];
  if (environmentArtifact?.value?.environmentProfileId !== metadata.environmentProfileId) {
    invalidate(
      environmentArtifact as LoadedArtifact,
      diagnostics,
      "INVALID_REFERENCE",
      "Metadata environment profile ID does not match the authoritative registered environment profile",
    );
  }

  let changed = true;
  while (changed) {
    changed = false;
    const validArtifacts = artifacts.filter((artifact) => artifact.valid && artifact.value);
    const valuesOf = (type: ArtifactType): LoadedArtifact[] =>
      validArtifacts.filter((artifact) => artifact.record.type === type);
    for (const artifact of validArtifacts) {
      try {
        assertPersistedPlanningSemantics(artifact, validArtifacts);
      } catch (error: unknown) {
        changed = invalidate(
          artifact,
          diagnostics,
          "INVALID_REFERENCE",
          error instanceof Error ? error.message : "Persisted planning semantic validation failed",
        ) || changed;
      }
    }
    const attempts = new Map<unknown, LoadedArtifact[]>();
    for (const artifact of valuesOf("test-result")) {
      const attemptId = artifact.value?.attemptId;
      attempts.set(attemptId, [...(attempts.get(attemptId) ?? []), artifact]);
    }
    for (const duplicates of attempts.values()) {
      if (duplicates.length > 1) {
        for (const artifact of duplicates) {
          changed = invalidate(artifact, diagnostics, "AMBIGUOUS_ATTEMPT", `Attempt ${String(artifact.value?.attemptId)} has multiple definitions`) || changed;
        }
      }
    }
    for (const artifact of validArtifacts) {
      const value = artifact.value as Record<string, unknown>;
      if (artifact.record.type === "test-result") {
        const matches = valuesOf("test-case").filter((candidate) =>
          candidate.value?.testCaseId === value.testCaseId
          && candidate.value?.revisionId === value.testCaseRevisionId
          && candidate.value?.instanceId === value.testCaseInstanceId
        );
        if (matches.length !== 1) {
          changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Test result must reference exactly one registered test case revision and instance") || changed;
        }
      } else if (artifact.record.type === "test-step-result") {
        const matchingAttempts = valuesOf("test-result").filter((candidate) => candidate.value?.attemptId === value.attemptId);
        const result = matchingAttempts.length === 1 ? matchingAttempts[0]?.value : undefined;
        const matchingCases = result
          ? valuesOf("test-case").filter((candidate) =>
            candidate.value?.testCaseId === result.testCaseId
            && candidate.value?.revisionId === result.testCaseRevisionId
          )
          : [];
        const steps = matchingCases.length === 1 ? matchingCases[0]?.value?.steps : undefined;
        if (
          matchingAttempts.length !== 1
          || matchingCases.length !== 1
          || !Array.isArray(steps)
          || !steps.some((step) => isRecord(step) && step.id === value.stepId)
        ) {
          changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Test step result must reference one registered attempt and test case step") || changed;
        }
      } else if (artifact.record.type === "evidence") {
        if (value.pendingAttempt === true) continue;
        const matches = valuesOf("test-result").filter((candidate) => candidate.value?.attemptId === value.attemptId);
        if (matches.length !== 1) {
          changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Evidence must reference exactly one registered attempt") || changed;
        }
      } else if (artifact.record.type === "bug-report") {
        const matchingAttempts = valuesOf("test-result").filter((candidate) => candidate.value?.attemptId === value.attemptId);
        const evidenceIds = value.evidenceIds;
        const sourceAttemptIds = isRecord(value.provenance) && Array.isArray(value.provenance.sourceAttemptIds) ? value.provenance.sourceAttemptIds : [];
        const evidenceValid = Array.isArray(evidenceIds) && evidenceIds.every((evidenceId) =>
          valuesOf("evidence").filter((candidate) =>
            candidate.value?.evidenceId === evidenceId
            && sourceAttemptIds.includes(candidate.value?.attemptId)
          ).length === 1
        );
        const sourceAttempts = sourceAttemptIds.map((attemptId) => valuesOf("test-result").find((candidate) => candidate.value?.attemptId === attemptId)?.value);
        let reproductionValid = false;
        try {
          reproductionValid = sourceAttempts.every((attempt) => attempt !== undefined)
            && stableJson(value.reproduction) === stableJson(evaluateReproduction(sourceAttempts.filter((attempt): attempt is Record<string, unknown> => attempt !== undefined).map((attempt) => ({ attemptId: String(attempt.attemptId), status: String(attempt.status), failureClassification: String(attempt.failureClassification) })), isRecord(value.reproduction) && typeof value.reproduction.unsafeRerunReason === "string" ? { unsafeRerunReason: value.reproduction.unsafeRerunReason } : {}));
        } catch { reproductionValid = false; }
        const original = matchingAttempts[0]?.value;
        const caseValue = original === undefined ? undefined : valuesOf("test-case").find((candidate) => candidate.value?.testCaseId === original.testCaseId && candidate.value?.revisionId === original.testCaseRevisionId && candidate.value?.instanceId === original.testCaseInstanceId)?.value;
        const approvedPlanCase = original === undefined ? undefined : valuesOf("test-plan").flatMap((candidate) => isRecord(candidate.value?.approvalDecision) && candidate.value.approvalDecision.approved === true && Array.isArray(candidate.value.testCases)
          ? candidate.value.testCases.filter(isRecord).filter((planCase) => planCase.testCaseId === original.testCaseId && (!isRecord(planCase.browserExecution) || planCase.browserExecution.revisionId === original.testCaseRevisionId)) : [])
          .find((planCase) => Array.isArray(planCase.expectedResults));
        const plannedExpected = approvedPlanCase && Array.isArray(approvedPlanCase.expectedResults) ? approvedPlanCase.expectedResults.filter(isRecord).filter((item) => typeof item.text === "string" && item.text.length > 0).map((item) => item.text).join(" ") : undefined;
        const expected = plannedExpected || (isRecord(caseValue?.coverage) && typeof caseValue.coverage.outcome === "string" ? caseValue.coverage.outcome : caseValue?.title);
        const observed = valuesOf("test-step-result").map((candidate) => candidate.value).find((step) => sourceAttemptIds.includes(step?.attemptId) && (typeof step?.observedActual === "string" || typeof step?.error === "string"));
        const telemetry = valuesOf("evidence").flatMap((candidate) => sourceAttemptIds.includes(candidate.value?.attemptId) ? array(candidate.value?.telemetryFindings) : []).find((finding) => isRecord(finding) && typeof finding.message === "string");
        const actual = typeof observed?.observedActual === "string" ? observed.observedActual : typeof observed?.error === "string" ? observed.error : isRecord(telemetry) && typeof telemetry.message === "string" ? telemetry.message : "Unknown observed actual (no registered step, error, or telemetry observation).";
        const revision = typeof value.revision === "number" ? value.revision : 1;
        const siblings = valuesOf("bug-report").filter((candidate) => candidate.value?.bugId === value.bugId);
        const predecessor = revision > 1 ? siblings.find((candidate) => candidate.record.id === value.supersedesArtifactId && candidate.value?.fingerprint === value.fingerprint && (typeof candidate.value?.revision === "number" ? candidate.value.revision : 1) === revision - 1) : undefined;
        const duplicateRevision = siblings.filter((candidate) => (typeof candidate.value?.revision === "number" ? candidate.value.revision : 1) === revision).length !== 1;
        let duplicateSourcesValid = Array.isArray(value.possibleDuplicateSources) || value.possibleDuplicateSources === undefined;
        if (Array.isArray(value.possibleDuplicateSources)) for (const source of value.possibleDuplicateSources) {
          if (!isRecord(source) || typeof source.runId !== "string" || source.runId === expectedRunId || typeof source.artifactId !== "string" || typeof source.sha256 !== "string" || source.fingerprint !== value.fingerprint || typeof source.bugId !== "string") { duplicateSourcesValid = false; continue; }
          try {
            const comparison = await RunWorkspace.open(dirname(dirname(path)), source.runId);
            try {
              const sourceRecord = await comparison.readArtifactRecord(source.artifactId);
              const sourceArtifact = (await comparison.readRegisteredArtifacts()).find((candidate) => candidate.record.id === source.artifactId && candidate.record.type === "bug-report");
              if (!sourceArtifact || sourceRecord.sha256 !== source.sha256 || sourceArtifact.value.runId !== source.runId || sourceArtifact.value.bugId !== source.bugId || sourceArtifact.value.fingerprint !== source.fingerprint) duplicateSourcesValid = false;
            } finally { await comparison.close(); }
          } catch { duplicateSourcesValid = false; }
        }
        if (matchingAttempts.length !== 1 || !evidenceValid || !reproductionValid || value.expected !== expected || value.actual !== actual || !duplicateSourcesValid || duplicateRevision || (revision > 1 && (!predecessor || !artifact.record.relationships.includes(predecessor.record.id))) || (revision === 1 && value.supersedesArtifactId !== undefined)) {
          changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Bug report must reference one attempt and registered evidence from that attempt") || changed;
        }
      } else if (artifact.record.type === "incident") {
        const attempt = valuesOf("test-result").find((candidate) => candidate.value?.attemptId === value.attemptId)?.value;
        const evidenceOk = Array.isArray(value.evidenceIds) && value.evidenceIds.length > 0 && value.evidenceIds.every((id) => valuesOf("evidence").some((candidate) => candidate.value?.evidenceId === id && candidate.value?.attemptId === value.attemptId && candidate.value?.runId === expectedRunId));
        const gapOk = Array.isArray(value.evidenceGapIds) && value.evidenceGapIds.length > 0 && value.evidenceGapIds.every((id) => valuesOf("evidence-gap").some((candidate) => candidate.value?.evidenceGapId === id && candidate.value?.attemptId === value.attemptId && candidate.value?.runId === expectedRunId));
        const kind = attempt?.failureClassification === "TEST_DEFECT" ? "TEST_INCIDENT" : attempt?.failureClassification === "ENVIRONMENT_DEFECT" ? "ENVIRONMENT_INCIDENT" : attempt?.failureClassification === "UNDETERMINED" ? "INVESTIGATION_FINDING" : undefined;
        if (!attempt || attempt.status === "PASSED" || value.kind !== kind || (!evidenceOk && !gapOk)) changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Incident must bind its exact non-product attempt to registered evidence or an evidence gap") || changed;
      } else if (artifact.record.type === "release-gate") {
        const derived = deriveReleaseGateFromWorkspaceArtifacts(validArtifacts
          .filter((candidate) => candidate.record.type !== "release-gate" && candidate.record.type !== "qa-execution-report" && candidate.value !== undefined)
          .map((candidate) => ({ record: { id: candidate.record.id, sha256: candidate.record.sha256, type: candidate.record.type }, value: candidate.value as Record<string, unknown> })));
        if (value.runId !== expectedRunId
          || JSON.stringify(value.sourceArtifacts) !== JSON.stringify(derived.sourceArtifacts)
          || JSON.stringify(value.ruleInputs) !== JSON.stringify(derived.ruleInputs)
          || JSON.stringify(value.verdicts) !== JSON.stringify(derived.verdicts)
          || value.recommendation !== derived.recommendation) {
          changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Release gate is not derived from the complete manifest facts") || changed;
        }
      } else if (artifact.record.type === "qa-execution-report") {
        const gates = valuesOf("release-gate");
        const gate = gates.length === 1 ? gates[0]?.value : undefined;
        const expectedGate = gate === undefined ? undefined : { sourceArtifacts: gate.sourceArtifacts, recommendation: gate.recommendation, ruleInputs: gate.ruleInputs, verdicts: gate.verdicts };
        if (!gate || !isRecord(value.releaseGate) || value.releaseRecommendation !== gate.recommendation || stableJson(value.releaseGate) !== stableJson(expectedGate)) {
          changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "QA report must embed the complete registered release gate") || changed;
        }
      } else if (artifact.record.type === "test-data-manifest") {
        const resources = value.resources;
        if (!uniqueResourceIds(resources) || !resources.every((resource) => resource.ownerRunId === expectedRunId)) {
          changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Test data resource owner run does not match this workspace") || changed;
        }
      } else if (artifact.record.type === "cleanup-run") {
        if (value.runId !== expectedRunId || typeof value.sourceRunId !== "string" || value.sourceRunId === expectedRunId || value.sourceRunId !== metadata.linkedRunId) {
          changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Cleanup run must be linked to a distinct immutable source run") || changed;
        } else try {
          await assertCleanupProvenance(path, value);
        } catch (error: unknown) {
          changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", error instanceof Error ? error.message : "Cleanup provenance is invalid") || changed;
        }
      } else if (artifact.record.type === "exploration-charter") {
        const charters = valuesOf("exploration-charter");
        const environment = valuesOf("environment-profile")[0];
        if (value.runId !== expectedRunId || charters.length !== 1 || !environment || artifact.record.relationships.length !== 1 || artifact.record.relationships[0] !== environment.record.id) {
          changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Exploration charter must be the sole run-bound charter linked to the environment") || changed;
        }
      } else if (artifact.record.type === "regression-selection") {
        const decisions = [...array(value.selected), ...array(value.excluded)];
        const decisionCases = decisions.flatMap((decision) => isRecord(decision) ? valuesOf("test-case").filter((testCase) => testCase.value?.testCaseId === decision.testCaseId && testCase.value?.revisionId === decision.revisionId) : []);
        const relationshipIds = [...artifact.record.relationships].sort();
        const expectedIds = decisionCases.map((testCase) => testCase.record.id).sort();
        const scope = artifacts.find((candidate) => candidate.valid && candidate.record.id === value.changeScopeArtifactId && candidate.record.type === "change-scope");
        const expectedDecisionChecksum = sha256Text(JSON.stringify({ selected: value.selected, excluded: value.excluded, unmappedChangeRisks: value.unmappedChangeRisks, complete: value.complete }));
        const recomputed = scope?.value && Array.isArray(scope.value.changes) ? selectRegressionCases({ changes: scope.value.changes as never, testCases: valuesOf("test-case").flatMap((testCase) => testCase.value === undefined ? [] : [regressionCaseFromCanonical(testCase.value)]) }) : undefined;
        if (value.runId !== expectedRunId || !scope || scope.record.sha256 !== value.changeScopeSha256 || value.decisionChecksum !== expectedDecisionChecksum || recomputed === undefined || stableJson({ selected: value.selected, excluded: value.excluded, unmappedChangeRisks: value.unmappedChangeRisks, complete: value.complete }) !== stableJson(recomputed) || decisionCases.length !== decisions.length || JSON.stringify(relationshipIds) !== JSON.stringify([scope.record.id, ...expectedIds].sort()) || (value.complete === true && array(value.unmappedChangeRisks).length > 0)) {
          changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Regression selection must bind every decision to one registered case and expose unmapped risk") || changed;
        }
      } else if (artifact.record.type === "change-scope") {
        const expectedChecksum = sha256Text(JSON.stringify({ changes: value.changes, provenance: value.provenance }));
        if (value.runId !== expectedRunId || value.inputChecksum !== expectedChecksum) {
          changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Change scope checksum does not match its registered mapping input") || changed;
        }
      } else if (artifact.record.type === "retest-result") {
        const reproductionIds = array(value.reproductionAttemptIds);
        const attempts = reproductionIds.map((id) => valuesOf("test-result").find((attempt) => attempt.value?.attemptId === id));
        const regressionAttempts = array(value.regressionAttemptIds).map((id) => valuesOf("test-result").find((attempt) => attempt.value?.attemptId === id));
        const relationships = [...attempts, ...regressionAttempts].map((attempt) => attempt?.record.id).filter((id): id is string => id !== undefined).sort();
        const sourceMatchesLink = typeof value.sourceRunId === "string" && value.sourceRunId === metadata.linkedRunId && value.sourceRunId !== expectedRunId;
        const scenarios = array(value.reproductionScenarios);
        const scenarioValid = scenarios.length === attempts.length && scenarios.every((scenario, index) => isRecord(scenario) && scenario.attemptId === reproductionIds[index] && scenario.status === attempts[index]?.value?.status && typeof scenario.scenarioId === "string");
        const derivedOutcome = regressionAttempts.length === array(value.regressionAttemptIds).length ? (() => { try { return deriveRegressionOutcome(regressionAttempts.map((attempt) => String(attempt?.value?.status))); } catch { return undefined; } })() : undefined;
        const derived = typeof value.bugId === "string" && scenarioValid ? deriveRetestVerdict({ originalBugId: value.bugId, reproductionStatuses: scenarios.map((scenario) => String(isRecord(scenario) ? scenario.status : "")), scenarioIds: scenarios.map((scenario) => String(isRecord(scenario) ? scenario.scenarioId : "")), ...(derivedOutcome === undefined ? {} : { regressionOutcome: derivedOutcome }) }) : undefined;
        let sourceBugValid = false;
        let reproductionMatchesSource = false;
        if (sourceMatchesLink && typeof value.sourceBugArtifactId === "string" && typeof value.sourceBugArtifactSha256 === "string" && typeof value.bugId === "string") try {
          const source = await RunWorkspace.open(dirname(dirname(path)), value.sourceRunId as string);
          try {
            const sourceRecord = await source.readArtifactRecord(value.sourceBugArtifactId);
            const sourceArtifacts = await source.readRegisteredArtifacts();
            const sourceBug = sourceArtifacts.find((candidate) => candidate.record.id === value.sourceBugArtifactId && candidate.record.type === "bug-report");
            const original = sourceBug === undefined ? undefined : sourceArtifacts.find((candidate) => candidate.record.type === "test-result" && candidate.value.attemptId === sourceBug.value.attemptId);
            sourceBugValid = sourceRecord.type === "bug-report" && sourceRecord.sha256 === value.sourceBugArtifactSha256 && sourceBug?.value.bugId === value.bugId;
            reproductionMatchesSource = original !== undefined && attempts.every((attempt) => attempt?.value?.testCaseId === original.value.testCaseId && attempt?.value?.testCaseRevisionId === original.value.testCaseRevisionId && attempt?.value?.testCaseInstanceId === original.value.testCaseInstanceId);
          } finally { await source.close(); }
        } catch { sourceBugValid = false; }
        if (value.runId !== expectedRunId || !sourceMatchesLink || !sourceBugValid || !reproductionMatchesSource || attempts.length === 0 || attempts.some((attempt) => !attempt) || regressionAttempts.some((attempt) => !attempt) || !scenarioValid || value.regressionOutcome !== derivedOutcome || JSON.stringify([...artifact.record.relationships].sort()) !== JSON.stringify(relationships) || value.verdict !== derived?.verdict) {
          changed = invalidate(artifact, diagnostics, "INVALID_REFERENCE", "Retest result must bind linked source and exact reproduction artifacts with a derived verdict") || changed;
        }
      }
    }
  }

  const evidenceDescriptors = artifacts.filter((artifact) => artifact.valid && artifact.record.type === "evidence" && artifact.value !== undefined);
  const binaryRecords = artifacts.filter((artifact) => artifact.valid && artifact.record.type === "evidence" && artifact.record.mediaType !== undefined);
  for (const descriptor of evidenceDescriptors) {
    const ids = descriptor.value?.binaryArtifactIds;
    const details = descriptor.value?.binaryArtifacts;
    if (!Array.isArray(ids) || !Array.isArray(details) || ids.length !== details.length || new Set(ids).size !== ids.length) {
      invalidate(descriptor, diagnostics, "INVALID_REFERENCE", "Evidence descriptor binary references are invalid");
      continue;
    }
    for (const detail of details) {
      if (!isRecord(detail) || typeof detail.id !== "string" || typeof detail.relativePath !== "string" || typeof detail.sha256 !== "string" || typeof detail.mediaType !== "string" || !ids.includes(detail.id)) {
        invalidate(descriptor, diagnostics, "INVALID_REFERENCE", "Evidence descriptor binary metadata is invalid");
        continue;
      }
      const binary = binaryRecords.find((candidate) => candidate.record.id === detail.id);
      if (!binary || binary.record.relativePath !== detail.relativePath || binary.record.sha256 !== detail.sha256 || binary.record.mediaType !== detail.mediaType) invalidate(descriptor, diagnostics, "INVALID_REFERENCE", "Evidence descriptor does not match its registered binary");
    }
    const primary = binaryRecords.find((candidate) => candidate.record.id === ids[0]);
    if (!primary || !matchesEvidencePrimary(descriptor.value as Record<string, unknown>, primary.record)) {
      invalidate(descriptor, diagnostics, "INVALID_REFERENCE", "Evidence descriptor does not match its designated primary binary");
    }
  }
  for (const binary of binaryRecords) {
    const references = evidenceDescriptors.filter((descriptor) => Array.isArray(descriptor.value?.binaryArtifactIds) && descriptor.value?.binaryArtifactIds.includes(binary.record.id));
    if (references.length !== 1) invalidate(binary, diagnostics, "INVALID_REFERENCE", "Evidence binary must be referenced exactly once by a canonical evidence descriptor");
  }

  const registered = new Set(manifest.artifacts.map((artifact) => artifact.relativePath));
  for (const directory of [join(path, "inputs"), join(path, "evidence")]) {
    for (const absolutePath of await filesUnder(path, directory)) {
      const relativePath = relative(path, absolutePath);
      if (!registered.has(relativePath)) addDiagnostic(diagnostics, { code: "ORPHAN_FILE", message: `Unregistered file ${relativePath}`, relativePath });
    }
  }
  return { metadata, manifest, artifacts, diagnostics };
}

export class RunWorkspace {
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private exclusive = false;
  private exclusivePromise: Promise<unknown> | undefined;
  private readonly activeMutations = new Set<Promise<unknown>>();
  private manifestTail: Promise<void> = Promise.resolve();

  private constructor(
  public readonly root: string,
  public readonly path: string,
  public readonly runId: string,
  public readonly mode: ArtifactProfileName,
    private metadata: WorkspaceMetadata,
    private readonly lock: RunLock | undefined,
    private readonly persistence: WorkspacePersistence,
  ) {}

  /** Immutable source linkage is exposed for linked workflow validation. */
  public get linkedRunId(): string | undefined { return this.metadata.linkedRunId; }

  public static async create(options: {
    root: string;
    mode: ArtifactProfileName;
    environmentProfile: Record<string, unknown>;
    linkedRunId?: string;
    persistence?: WorkspacePersistence;
  }): Promise<RunWorkspace> {
    if (!(artifactProfileNames as readonly string[]).includes(options.mode)) {
      throw new QaSkillsError("Invalid mode", "INVALID_MODE");
    }
    if (!validateArtifact("environment-profile", options.environmentProfile).valid) {
      throw new QaSkillsError("Invalid environment profile", "INVALID_ARTIFACT");
    }
    await mkdir(options.root, { recursive: true });
    const root = await realpath(options.root);
    const resultsPath = resolveWithin(root, "qa-results");
    await mkdir(resultsPath, { recursive: true });
    await assertRealpathWithin(root, "qa-results");
    const runId = createRunId();
    const runCandidate = resolveWithin(root, join("qa-results", runId));
    await mkdir(runCandidate);
    const path = await assertRealpathWithin(root, relative(root, runCandidate));
    const lock = await acquireRunLock(path);
    const profileId = options.environmentProfile.environmentProfileId;
    if (typeof profileId !== "string") throw new QaSkillsError("Environment profile ID is required", "INVALID_ARTIFACT");
    const metadata: WorkspaceMetadata = {
      artifactType: "run-metadata",
      schemaVersion: "1.0.0",
      producerVersion: "0.1.0",
      runId,
      status: "CREATED",
      createdAt: utcNow(),
      mode: options.mode,
      environmentProfileId: profileId,
      ...(options.linkedRunId ? { linkedRunId: options.linkedRunId } : {}),
    };
    const workspace = new RunWorkspace(
      root,
      path,
      runId,
      options.mode,
      metadata,
      lock,
      options.persistence ?? defaultPersistence,
    );
    await workspace.persistMetadata(metadata);
    await workspace.writeManifest({
      artifactType: "artifact-manifest",
      schemaVersion: "1.0.0",
      producerVersion: "0.1.0",
      runId,
      artifacts: [],
    });
    await workspace.registerCanonicalArtifact("environment-profile", options.environmentProfile, [], "runtime");
    return workspace;
  }

  public static async open(root: string, runId: string): Promise<RunWorkspace> {
    const realRoot = await realpath(root);
    const path = await assertRealpathWithin(realRoot, join("qa-results", runId));
    const inspected = await inspectWorkspaceState(path, runId);
    if (inspected.diagnostics.length > 0) {
      throw new QaSkillsError(`Workspace artifact binding is invalid: ${inspected.diagnostics[0]?.message ?? "unknown error"}`, "ARTIFACT_BINDING");
    }
    const lock = terminalStatuses.has(inspected.metadata.status) ? undefined : await acquireRunLock(path);
    return new RunWorkspace(realRoot, path, runId, inspected.metadata.mode, inspected.metadata, lock, defaultPersistence);
  }

  public async resolve(relativePath: string): Promise<string> {
    this.assertOpen();
    return assertRealpathWithin(this.path, relativePath);
  }

  public registerArtifact(input: {
    type: ArtifactType;
    sourcePath: string;
    relationships: string[];
    provenance?: string;
  }): Promise<ArtifactRecord & { absolutePath: string }> {
    try {
      this.assertWritable();
      if (!isArtifactType(input.type)) throw new QaSkillsError("Unsupported artifact type", "INVALID_ARTIFACT");
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return this.trackMutation(async () => {
      const sourcePath = resolve(input.sourcePath);
      const sourceRelative = relative(this.path, sourcePath);
      if (sourceRelative === "" || (!sourceRelative.startsWith("..") && !sourceRelative.startsWith("/"))) {
        await assertRealpathWithin(this.path, sourceRelative);
      }
      const sourceStats = await stat(sourcePath);
      if (!sourceStats.isFile()) throw new QaSkillsError("Artifact source must be a file", "INVALID_ARTIFACT");
      const source = await readFile(sourcePath, "utf8");
      const format = sourcePath.endsWith(".yaml") || sourcePath.endsWith(".yml") ? "yaml" : "json";
      const value = parseAuthoringDocument(source, format);
      if (!validateArtifact(input.type, value).valid) {
        throw new QaSkillsError("Artifact does not match its contract", "INVALID_ARTIFACT");
      }
      return this.registerArtifactValueInternal({
        type: input.type,
        value,
        relationships: input.relationships,
        ...(input.provenance ? { provenance: input.provenance } : {}),
      });
    });
  }

  public registerArtifactValue(input: {
    type: ArtifactType;
    value: unknown;
    relationships: string[];
    provenance?: string;
  }): Promise<ArtifactRecord & { absolutePath: string }> {
    let snapshot: unknown;
    let relationships: string[];
    try {
      snapshot = JSON.parse(JSON.stringify(input.value)) as unknown;
      relationships = [...input.relationships];
      this.assertWritable();
      if (!isArtifactType(input.type)) throw new QaSkillsError("Unsupported artifact type", "INVALID_ARTIFACT");
      if (!validateArtifact(input.type, snapshot).valid) {
        throw new QaSkillsError("Artifact does not match its contract", "INVALID_ARTIFACT");
      }
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return this.trackMutation(() => this.registerArtifactValueInternal({
      type: input.type,
      value: snapshot,
      relationships,
      ...(input.provenance ? { provenance: input.provenance } : {}),
    }));
  }

  /** Atomically writes a media artifact inside the workspace and immediately records it in the authoritative manifest. */
  public registerBinaryArtifact(input: {
    type: "evidence";
    filename: string;
    contents: Uint8Array;
    mediaType: string;
    captureType: "screenshot" | "trace" | "console" | "network" | "log";
    dimensions?: { width: number; height: number };
    relationships: string[];
    provenance?: string;
  }): Promise<ArtifactRecord & { absolutePath: string }> {
    try {
      this.assertWritable();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.filename) || input.contents.byteLength === 0) throw new QaSkillsError("Binary artifact filename or contents are invalid", "INVALID_ARTIFACT");
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return this.trackMutation(() => this.withManifestTransaction(async () => {
      const manifest = await this.readManifest();
      const unknownRelationship = input.relationships.find((relationship) => !manifest.artifacts.some((artifact) => artifact.id === relationship));
      if (unknownRelationship) throw new QaSkillsError(`Relationship ${unknownRelationship} is not registered in this workspace`, "ARTIFACT_BINDING");
      const id = createEntityId();
      const relativePath = `evidence/${id}-${input.filename}`;
      const absolutePath = resolveWithin(this.path, relativePath);
      await atomicWriteFile(this.path, absolutePath, input.contents);
      const checksum = await sha256(absolutePath);
      const record: ArtifactRecord = {
        id, type: input.type, relativePath, sha256: checksum, mediaType: input.mediaType, captureType: input.captureType,
        ...(input.dimensions === undefined ? {} : { dimensions: { ...input.dimensions } }), provenance: input.provenance ?? "runtime", relationships: [...input.relationships],
      };
      try {
        await this.writeManifest({ ...manifest, artifacts: [...manifest.artifacts, record] });
      } catch (error) {
        await rm(absolutePath, { force: true });
        throw error;
      }
      return { ...record, absolutePath };
    }));
  }

  /** Writes evidence media and its canonical descriptor as one serialized manifest transaction. */
  public registerEvidenceBundle(input: {
    binaries: readonly {
      filename: string;
      contents: Uint8Array;
      mediaType: string;
      captureType: "screenshot" | "trace" | "console" | "network" | "log";
      dimensions?: { width: number; height: number };
    }[];
    descriptor: (binaries: readonly ArtifactRecord[]) => unknown;
    relationships?: string[];
    provenance?: string;
  }): Promise<{ binaries: readonly (ArtifactRecord & { absolutePath: string })[]; descriptor: ArtifactRecord & { absolutePath: string } }> {
    try {
      this.assertWritable();
      if (input.binaries.length === 0 || input.binaries.some((binary) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(binary.filename) || binary.contents.byteLength === 0)) throw new QaSkillsError("Evidence bundle binary is invalid", "INVALID_ARTIFACT");
    } catch (error: unknown) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    return this.trackMutation(() => this.withManifestTransaction(async () => {
      const manifest = await this.readManifest();
      const written: string[] = [];
      try {
        const planned = input.binaries.map((binary) => {
          const id = createEntityId();
          const relativePath = `evidence/${id}-${binary.filename}`;
          return { id, type: "evidence" as const, relativePath, sha256: sha256Bytes(binary.contents), mediaType: binary.mediaType, captureType: binary.captureType, ...(binary.dimensions === undefined ? {} : { dimensions: { ...binary.dimensions } }), provenance: input.provenance ?? "runtime", relationships: [] };
        });
        const value = input.descriptor(planned);
        if (!validateArtifact("evidence", value).valid) throw new QaSkillsError("Evidence descriptor does not match its contract", "INVALID_ARTIFACT");
        const relationships = [...(input.relationships ?? []), ...planned.map((binary) => binary.id)];
        const details = isRecord(value) ? value.binaryArtifacts : undefined;
        const ids = isRecord(value) ? value.binaryArtifactIds : undefined;
        if (!Array.isArray(ids) || !Array.isArray(details) || ids.length !== planned.length || details.length !== planned.length || !planned.every((binary, index) => ids[index] === binary.id && isRecord(details[index]) && details[index].id === binary.id && details[index].relativePath === binary.relativePath && details[index].sha256 === binary.sha256 && details[index].mediaType === binary.mediaType)) throw new QaSkillsError("Evidence bundle descriptor does not exactly reference its proposed binaries", "ARTIFACT_BINDING");
        const primary = planned[0];
        if (!primary || !matchesEvidencePrimary(value as Record<string, unknown>, primary)) throw new QaSkillsError("Evidence bundle descriptor does not match its designated primary binary", "ARTIFACT_BINDING");
        const withBinaries: Manifest = { ...manifest, artifacts: [...manifest.artifacts, ...planned] };
        await this.assertArtifactBinding("evidence", value, relationships, withBinaries);
        const canonicalContents = `${JSON.stringify(value, null, 2)}\n`;
        const checksum = sha256Text(canonicalContents);
        if (manifest.artifacts.some((artifact) => artifact.type === "evidence" && artifact.sha256 === checksum)) throw new QaSkillsError("Completed artifacts are immutable; duplicate artifact", "DUPLICATE_ARTIFACT");
        const descriptorId = createEntityId();
        const relativePath = `inputs/${descriptorId}-evidence.json`;
        const absolutePath = resolveWithin(this.path, relativePath);
        const binaries: (ArtifactRecord & { absolutePath: string })[] = [];
        for (const [index, binary] of input.binaries.entries()) {
          const record = planned[index];
          if (!record) throw new QaSkillsError("Evidence bundle planning failed", "WRITE_FAILURE");
          const binaryPath = resolveWithin(this.path, record.relativePath);
          written.push(binaryPath);
          await this.persistence.writeAtomic(this.path, binaryPath, binary.contents);
          if (await sha256(binaryPath) !== record.sha256) throw new QaSkillsError("Atomic evidence binary write checksum mismatch", "WRITE_FAILURE");
          binaries.push({ ...record, absolutePath: binaryPath });
        }
        written.push(absolutePath);
        await this.persistence.writeAtomic(this.path, absolutePath, canonicalContents);
        if (await sha256(absolutePath) !== checksum) throw new QaSkillsError("Atomic evidence descriptor write checksum mismatch", "WRITE_FAILURE");
        const descriptor: ArtifactRecord = { id: descriptorId, type: "evidence", relativePath, sha256: checksum, provenance: input.provenance ?? "runtime", relationships };
        await this.writeManifest({ ...withBinaries, artifacts: [...withBinaries.artifacts, descriptor] });
        return { binaries, descriptor: { ...descriptor, absolutePath } };
      } catch (error) {
        await Promise.all(written.map((path) => rm(path, { force: true })));
        throw error;
      }
    }));
  }

  private registerArtifactValueInternal(input: {
    type: ArtifactType;
    value: unknown;
    relationships: string[];
    provenance?: string;
  }): Promise<ArtifactRecord & { absolutePath: string }> {
    return this.withManifestTransaction(async () => {
      const manifest = await this.readManifest();
      const value = input.type === "test-plan"
        ? await this.withDerivedTestPlanApproval(input.value, manifest)
        : input.value;
      await this.assertArtifactBinding(input.type, value, input.relationships, manifest);
      return this.registerCanonicalArtifact(
        input.type,
        value,
        input.relationships,
        input.provenance ?? "agent-draft",
        manifest,
      );
    });
  }

  public transition(status: RunStatus): Promise<void> {
    try {
      this.assertWritable();
      if (status !== "RUNNING" || this.metadata.status !== "CREATED") {
        throw new QaSkillsError(`Lifecycle transition ${this.metadata.status} -> ${status} is reserved for finalize`, "ILLEGAL_TRANSITION");
      }
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return this.trackMutation(() => this.transitionInternal(status));
  }

  public async validate(profile: ArtifactProfileName = this.mode): Promise<WorkspaceValidation> {
    this.assertOpen();
    return this.validateInternal(profile);
  }

  /** Returns only freshly revalidated, manifest-registered immutable payloads. */
  public async readRegisteredArtifacts(): Promise<readonly RegisteredWorkspaceArtifact[]> {
    this.assertOpen();
    const inspected = await inspectWorkspaceState(this.path, this.runId);
    if (inspected.diagnostics.length > 0) {
      throw new QaSkillsError(`Workspace artifact binding is invalid: ${inspected.diagnostics[0]?.message ?? "unknown error"}`, "ARTIFACT_BINDING");
    }
    return inspected.artifacts.flatMap((artifact) => artifact.valid && artifact.value
      ? [{ record: artifact.record, value: artifact.value }]
      : []);
  }

  /** Returns a freshly validated manifest record, including registered evidence binaries. */
  public async readArtifactRecord(id: string): Promise<Readonly<ArtifactRecord>> {
    this.assertOpen();
    const inspected = await inspectWorkspaceState(this.path, this.runId);
    if (inspected.diagnostics.length > 0) throw new QaSkillsError(`Workspace artifact binding is invalid: ${inspected.diagnostics[0]?.message ?? "unknown error"}`, "ARTIFACT_BINDING");
    const record = inspected.manifest.artifacts.find((artifact) => artifact.id === id);
    if (!record) throw new QaSkillsError("Registered artifact was not found", "ARTIFACT_BINDING");
    return { ...record, relationships: [...record.relationships] };
  }

  public finalize(
    profile: ArtifactProfileName = this.mode,
    outcome?: ExplicitTerminalOutcome,
  ): Promise<WorkspaceValidation> {
    try {
      this.assertWritable();
      assertArtifactProfileName(profile);
      if (profile !== this.mode) {
        throw new QaSkillsError(`Finalization profile ${profile} does not match run mode ${this.mode}`, "INVALID_PROFILE");
      }
      if (outcome !== undefined && outcome !== "COMPLETED_WITH_FAILURES" && outcome !== "BLOCKED" && outcome !== "ABORTED") {
        throw new QaSkillsError(`Unsupported terminal outcome ${String(outcome)}`, "ILLEGAL_TRANSITION");
      }
      if (this.exclusive) throw new QaSkillsError("Workspace is already finalizing", "ILLEGAL_TRANSITION");
      this.exclusive = true;
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    const operation = this.finalizeInternal(profile, outcome);
    this.exclusivePromise = operation;
    void operation.then(
      () => {
        this.exclusivePromise = undefined;
      },
      () => {
        this.exclusivePromise = undefined;
        if (!terminalStatuses.has(this.metadata.status)) this.exclusive = false;
      },
    );
    return operation;
  }

  public close(): Promise<void> {
    this.closed = true;
    if (!this.closePromise) {
      this.closePromise = (async () => {
        while (this.activeMutations.size > 0) {
          await Promise.allSettled([...this.activeMutations]);
        }
        if (this.exclusivePromise) await Promise.allSettled([this.exclusivePromise]);
        await this.lock?.release();
      })().catch((error: unknown) => {
        this.closePromise = undefined;
        throw error;
      });
    }
    return this.closePromise;
  }

  private async finalizeInternal(
    profile: ArtifactProfileName,
    outcome?: ExplicitTerminalOutcome,
  ): Promise<WorkspaceValidation> {
    while (this.activeMutations.size > 0) await Promise.all([...this.activeMutations]);
    if (this.metadata.status === "CREATED") await this.transitionInternal("RUNNING");
    if (this.metadata.status !== "RUNNING") {
      throw new QaSkillsError(`Cannot finalize a ${this.metadata.status} workspace`, "ILLEGAL_TRANSITION");
    }
    const result = await this.validateInternal(profile);
    await this.transitionInternal("FINALIZING");
    const terminal = outcome ?? (result.valid ? "COMPLETED" : "COMPLETED_WITH_FAILURES");
    await this.transitionTerminal(terminal, profile);
    return result;
  }

  private async validateInternal(profile: ArtifactProfileName): Promise<WorkspaceValidation> {
    assertArtifactProfileName(profile);
    const inspected = await inspectWorkspaceState(this.path, this.runId);
    const diagnostics = [...inspected.diagnostics];
    const validTypes = inspected.artifacts
      .filter((artifact) => artifact.valid)
      .map((artifact) => artifact.record.type);
    diagnostics.push(...evaluateArtifactProfile(profile, ["run-metadata", ...validTypes]).diagnostics);
    return { valid: diagnostics.length === 0, diagnostics };
  }

  private assertOpen(): void {
    if (this.closed) throw new QaSkillsError("Workspace is closed", "CLOSED_WORKSPACE");
  }

  private assertWritable(): void {
    this.assertOpen();
    if (terminalStatuses.has(this.metadata.status)) {
      throw new QaSkillsError("Terminal workspace is immutable", "TERMINAL_WORKSPACE");
    }
    if (this.exclusive || this.metadata.status === "FINALIZING") {
      throw new QaSkillsError("Workspace is finalizing and rejects new writes", "FINALIZING_WORKSPACE");
    }
  }

  private trackMutation<T>(operation: () => Promise<T>): Promise<T> {
    const promise = operation();
    this.activeMutations.add(promise);
    void promise.then(
      () => this.activeMutations.delete(promise),
      () => this.activeMutations.delete(promise),
    );
    return promise;
  }

  private withManifestTransaction<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.manifestTail.then(operation, operation);
    this.manifestTail = current.then(() => undefined, () => undefined);
    return current;
  }

  private async assertArtifactBinding(
    type: ArtifactType,
    value: unknown,
    relationships: string[],
    manifest: Manifest,
  ): Promise<void> {
    if (!isRecord(value)) throw new QaSkillsError("Artifact binding requires an object", "ARTIFACT_BINDING");
    if (Object.hasOwn(value, "runId") && value.runId !== this.runId) {
      throw new QaSkillsError("Artifact run ID does not match this workspace", "ARTIFACT_BINDING");
    }
    if (Object.hasOwn(value, "environmentProfileId") && value.environmentProfileId !== this.metadata.environmentProfileId) {
      throw new QaSkillsError("Artifact environment profile ID does not match this workspace", "ARTIFACT_BINDING");
    }
    if (type === "environment-profile") {
      if (value.environmentProfileId !== this.metadata.environmentProfileId) {
        throw new QaSkillsError("Environment profile does not match this workspace", "ARTIFACT_BINDING");
      }
      if (manifest.artifacts.some((artifact) => artifact.type === "environment-profile")) {
        throw new QaSkillsError("The workspace already has an authoritative environment profile", "ARTIFACT_BINDING");
      }
    }
    const knownIds = new Set(manifest.artifacts.map((artifact) => artifact.id));
    const unknownRelationship = relationships.find((relationship) => !knownIds.has(relationship));
    if (unknownRelationship) {
      throw new QaSkillsError(`Relationship ${unknownRelationship} is not registered in this workspace`, "ARTIFACT_BINDING");
    }
    await this.assertSemanticReferences(type, value, relationships, manifest);
  }

  private async transitionInternal(status: RunStatus): Promise<void> {
    if (terminalStatuses.has(status)) {
      throw new QaSkillsError("Terminal transitions require finalization", "ILLEGAL_TRANSITION");
    }
    if (!nextStatuses[this.metadata.status].includes(status)) {
      throw new QaSkillsError(`Illegal lifecycle transition: ${this.metadata.status} -> ${status}`, "ILLEGAL_TRANSITION");
    }
    const next = { ...this.metadata, status };
    await this.persistMetadata(next);
    this.metadata = next;
  }

  private async transitionTerminal(
    status: Extract<RunStatus, "COMPLETED" | "COMPLETED_WITH_FAILURES" | "BLOCKED" | "ABORTED">,
    profile: ArtifactProfileName,
  ): Promise<void> {
    if (!nextStatuses[this.metadata.status].includes(status)) {
      throw new QaSkillsError(`Illegal lifecycle transition: ${this.metadata.status} -> ${status}`, "ILLEGAL_TRANSITION");
    }
    const terminal: WorkspaceMetadata = {
      ...this.metadata,
      status,
      finalizedProfile: { name: profile, version: artifactProfileVersion },
    };
    try {
      await this.persistMetadata(terminal);
      this.metadata = terminal;
    } catch (error: unknown) {
      const running: WorkspaceMetadata = { ...this.metadata, status: "RUNNING" };
      delete running.finalizedProfile;
      await this.persistMetadata(running);
      this.metadata = running;
      throw error;
    }
    await this.lock?.release();
  }

  private async readRegisteredValues(manifest: Manifest, type: ArtifactType): Promise<Record<string, unknown>[]> {
    return Promise.all(manifest.artifacts.filter((artifact) => artifact.type === type && artifact.mediaType === undefined).map(async (artifact) => {
      const path = await assertRealpathWithin(this.path, artifact.relativePath);
      if (await sha256(path) !== artifact.sha256) {
        throw new QaSkillsError(`Referenced ${type} checksum mismatch`, "ARTIFACT_BINDING");
      }
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!isRecord(value) || !validateArtifact(type, value).valid) {
        throw new QaSkillsError(`Referenced ${type} is invalid`, "ARTIFACT_BINDING");
      }
      return value;
    }));
  }

  private async readGateWorkspaceArtifacts(manifest: Manifest): Promise<readonly { record: { id: string; sha256: string; type: string }; value: Record<string, unknown> }[]> {
    return Promise.all(manifest.artifacts
      .filter((artifact) => artifact.mediaType === undefined && artifact.type !== "release-gate" && artifact.type !== "qa-execution-report")
      .map(async (artifact) => {
        const path = await assertRealpathWithin(this.path, artifact.relativePath);
        if (await sha256(path) !== artifact.sha256) throw new QaSkillsError(`Referenced ${artifact.type} checksum mismatch`, "ARTIFACT_BINDING");
        const value = JSON.parse(await readFile(path, "utf8")) as unknown;
        if (!isRecord(value) || !validateArtifact(artifact.type, value).valid) throw new QaSkillsError(`Referenced ${artifact.type} is invalid`, "ARTIFACT_BINDING");
        return { record: { id: artifact.id, sha256: artifact.sha256, type: artifact.type }, value };
      }));
  }

  private async assertSemanticReferences(
    type: ArtifactType,
    value: Record<string, unknown>,
    relationships: string[],
    manifest: Manifest,
  ): Promise<void> {
    if (type === "requirement-analysis") {
      try {
        assertRequirementAuthorities(value);
      } catch (error: unknown) {
        throw new QaSkillsError(error instanceof Error ? error.message : "Requirement authority verification failed", "ARTIFACT_BINDING");
      }
    } else if (type === "test-plan") {
      await this.assertTestPlanPolicy(value, manifest);
    } else if (type === "coverage-obligation") {
      await this.assertCoverageObligationBinding(value, manifest);
    } else if (type === "test-result") {
      const testCases = await this.readRegisteredValues(manifest, "test-case");
      if (testCases.filter((testCase) =>
        testCase.testCaseId === value.testCaseId
        && testCase.revisionId === value.testCaseRevisionId
        && testCase.instanceId === value.testCaseInstanceId
      ).length !== 1) {
        throw new QaSkillsError("Test result references an unregistered or ambiguous test case revision and instance", "ARTIFACT_BINDING");
      }
      const testResults = await this.readRegisteredValues(manifest, "test-result");
      if (testResults.some((result) => result.attemptId === value.attemptId)) {
        throw new QaSkillsError("Test result attempt ID is already registered and would be ambiguous", "ARTIFACT_BINDING");
      }
    } else if (type === "test-step-result") {
      const testResults = await this.readRegisteredValues(manifest, "test-result");
      const matches = testResults.filter((result) => result.attemptId === value.attemptId);
      const testResult = matches.length === 1 ? matches[0] : undefined;
      if (!testResult) throw new QaSkillsError("Test step result references an unregistered or ambiguous attempt", "ARTIFACT_BINDING");
      const testCases = await this.readRegisteredValues(manifest, "test-case");
      const matchingCases = testCases.filter((candidate) =>
        candidate.testCaseId === testResult.testCaseId
        && candidate.revisionId === testResult.testCaseRevisionId
      );
      const steps = matchingCases.length === 1 ? matchingCases[0]?.steps : undefined;
      if (!Array.isArray(steps) || !steps.some((step) => isRecord(step) && step.id === value.stepId)) {
        throw new QaSkillsError("Test step result references an unregistered step", "ARTIFACT_BINDING");
      }
    } else if (type === "evidence") {
      if (value.pendingAttempt !== true) {
        const testResults = await this.readRegisteredValues(manifest, "test-result");
        if (testResults.filter((result) => result.attemptId === value.attemptId).length !== 1) throw new QaSkillsError("Evidence references an unregistered or ambiguous attempt", "ARTIFACT_BINDING");
      }
    } else if (type === "bug-report") {
      const testResults = await this.readRegisteredValues(manifest, "test-result");
      const sourceAttemptIds = isRecord(value.provenance) && Array.isArray(value.provenance.sourceAttemptIds) ? value.provenance.sourceAttemptIds : [];
      const reproductionAttemptIds = isRecord(value.reproduction) && Array.isArray(value.reproduction.attemptIds) ? value.reproduction.attemptIds : [];
      if (reproductionAttemptIds.length === 0 || sourceAttemptIds.length === 0 || value.attemptId !== sourceAttemptIds[0]
        || sourceAttemptIds.length !== reproductionAttemptIds.length
        || !sourceAttemptIds.every((id, index) => id === reproductionAttemptIds[index])
        || !sourceAttemptIds.every((attemptId) => testResults.filter((result) => result.attemptId === attemptId).length === 1)) {
        throw new QaSkillsError("Bug report reproduction references unregistered or ambiguous attempts", "ARTIFACT_BINDING");
      }
      const original = testResults.find((result) => result.attemptId === value.attemptId);
      if (original?.status !== "FAILED" || original.failureClassification !== "PRODUCT_DEFECT") {
        throw new QaSkillsError("Only FAILED PRODUCT_DEFECT attempts may create a bug report", "ARTIFACT_BINDING");
      }
      const sourceAttempts = sourceAttemptIds.map((attemptId) => testResults.find((result) => result.attemptId === attemptId));
      if (sourceAttempts.some((attempt) => !attempt)) throw new QaSkillsError("Bug report reproduction is incomplete", "ARTIFACT_BINDING");
      const unsafeRerunReason = isRecord(value.reproduction) && typeof value.reproduction.unsafeRerunReason === "string" ? value.reproduction.unsafeRerunReason : undefined;
      let derivedReproduction: ReturnType<typeof evaluateReproduction>;
      try {
        derivedReproduction = evaluateReproduction(sourceAttempts.map((attempt) => ({
          attemptId: String(attempt?.attemptId), status: String(attempt?.status), failureClassification: String(attempt?.failureClassification),
        })), unsafeRerunReason === undefined ? {} : { unsafeRerunReason });
      } catch (error: unknown) {
        throw new QaSkillsError(error instanceof Error ? error.message : "Bug reproduction is invalid", "ARTIFACT_BINDING");
      }
      if (JSON.stringify(value.reproduction) !== JSON.stringify(derivedReproduction)) throw new QaSkillsError("Bug reproduction must equal the registered attempt evaluation", "ARTIFACT_BINDING");
      const existingBugs = await this.readRegisteredValues(manifest, "bug-report");
      const sameFingerprint = existingBugs.filter((bug) => bug.fingerprint === value.fingerprint);
      const prior = [...sameFingerprint].sort((left, right) => (typeof right.revision === "number" ? right.revision : 1) - (typeof left.revision === "number" ? left.revision : 1))[0];
      const expectedBugId = prior?.bugId ?? createRunScopedBugId(String(original.testCaseId), this.runId, new Set(existingBugs.map((bug) => String(bug.bugId))).size + 1);
      const expectedRevision = prior ? (typeof prior.revision === "number" ? prior.revision : 1) + 1 : 1;
      const priorRecord = prior ? (await this.readGateWorkspaceArtifacts(manifest)).find((artifact) => artifact.value.bugId === prior.bugId && artifact.value.revision === prior.revision) : undefined;
      if (value.bugId !== expectedBugId || existingBugs.some((bug) => bug.attemptId === value.attemptId)
        || (value.revision !== undefined && value.revision !== expectedRevision)
        || (prior && (!priorRecord || value.supersedesArtifactId !== priorRecord.record.id || !relationships.includes(priorRecord.record.id)))) {
        throw new QaSkillsError("Bug ID or original-attempt identity is not deterministic", "ARTIFACT_BINDING");
      }
      if (!Array.isArray(value.affectedAreas) || typeof value.expected !== "string" || typeof value.actual !== "string"
        || value.fingerprint !== createBugFingerprint({ feature: String(original.testCaseId), expected: value.expected, actual: value.actual, affectedAreas: value.affectedAreas.map(String) })) {
        throw new QaSkillsError("Bug fingerprint is not canonical", "ARTIFACT_BINDING");
      }
      const evidenceItems = await this.readRegisteredValues(manifest, "evidence");
      const evidenceIds = value.evidenceIds;
      if (!Array.isArray(evidenceIds) || !evidenceIds.every((evidenceId) => evidenceItems.filter(
        (evidence) => evidence.evidenceId === evidenceId && sourceAttemptIds.includes(evidence.attemptId as string),
      ).length === 1)) {
        throw new QaSkillsError("Bug report references unregistered or ambiguous evidence for its reproduction set", "ARTIFACT_BINDING");
      }
      const evidenceArtifactIds = isRecord(value.provenance) && Array.isArray(value.provenance.evidenceArtifactIds) ? value.provenance.evidenceArtifactIds : [];
      if (!evidenceArtifactIds.every((id) => {
        if (typeof id !== "string") return false;
        return manifest.artifacts.some((artifact) => artifact.id === id && artifact.type === "evidence") && relationships.includes(id);
      })) {
        throw new QaSkillsError("Bug report evidence provenance is not registered", "ARTIFACT_BINDING");
      }
      const testCases = await this.readRegisteredValues(manifest, "test-case");
      const testCase = testCases.find((candidate) => candidate.testCaseId === original.testCaseId && candidate.revisionId === original.testCaseRevisionId && candidate.instanceId === original.testCaseInstanceId);
      const plans = await this.readRegisteredValues(manifest, "test-plan");
      const approvedPlanCase = plans.flatMap((plan) => plan.approvalDecision && isRecord(plan.approvalDecision) && plan.approvalDecision.approved === true && Array.isArray(plan.testCases)
        ? plan.testCases.filter(isRecord).filter((candidate) => candidate.testCaseId === original.testCaseId && (!isRecord(candidate.browserExecution) || candidate.browserExecution.revisionId === original.testCaseRevisionId)) : [])
        .find((candidate) => Array.isArray(candidate.expectedResults));
      const plannedExpected = approvedPlanCase && Array.isArray(approvedPlanCase.expectedResults)
        ? approvedPlanCase.expectedResults.filter(isRecord).filter((item) => typeof item.text === "string" && item.text.length > 0).map((item) => item.text).join(" ") : undefined;
      const coverage = testCase?.coverage;
      const derivedExpected = plannedExpected || (isRecord(coverage) && typeof coverage.outcome === "string" ? coverage.outcome : testCase?.title);
      const steps = await this.readRegisteredValues(manifest, "test-step-result");
      const observedStep = steps.find((step) => sourceAttemptIds.includes(String(step.attemptId)) && (typeof step.observedActual === "string" || typeof step.error === "string"));
      const evidence = await this.readRegisteredValues(manifest, "evidence");
      const observedTelemetry = evidence.flatMap((item) => sourceAttemptIds.includes(String(item.attemptId)) ? array(item.telemetryFindings) : []).find((item) => isRecord(item) && typeof item.message === "string");
      const derivedActual = typeof observedStep?.observedActual === "string" ? observedStep.observedActual
        : typeof observedStep?.error === "string" ? observedStep.error
          : isRecord(observedTelemetry) && typeof observedTelemetry.message === "string" ? observedTelemetry.message
            : "Unknown observed actual (no registered step, error, or telemetry observation).";
      if (value.expected !== derivedExpected || value.actual !== derivedActual
        || (derivedActual.startsWith("Unknown observed actual") && (!Array.isArray(value.openQuestions) || !value.openQuestions.includes("No registered observable actual was available.")))) {
        throw new QaSkillsError("Bug expected and actual must derive from the approved testcase revision and registered failed observation", "ARTIFACT_BINDING");
      }
      if (value.possibleDuplicateSources !== undefined) {
        if (!Array.isArray(value.possibleDuplicateSources)) throw new QaSkillsError("Cross-run duplicate sources are invalid", "ARTIFACT_BINDING");
        for (const source of value.possibleDuplicateSources) {
          if (!isRecord(source) || typeof source.runId !== "string" || source.runId === this.runId || typeof source.artifactId !== "string" || typeof source.sha256 !== "string" || typeof source.bugId !== "string" || source.fingerprint !== value.fingerprint) {
            throw new QaSkillsError("Cross-run duplicate source is not an explicit checksum-bound reference", "ARTIFACT_BINDING");
          }
          const comparison = await RunWorkspace.open(this.root, source.runId);
          try {
            const sourceRecord = await comparison.readArtifactRecord(source.artifactId);
            const sourceArtifact = (await comparison.readRegisteredArtifacts()).find((artifact) => artifact.record.id === source.artifactId && artifact.record.type === "bug-report");
            if (!sourceArtifact || sourceRecord.sha256 !== source.sha256 || sourceArtifact.value.runId !== source.runId || sourceArtifact.value.bugId !== source.bugId || sourceArtifact.value.fingerprint !== source.fingerprint) {
              throw new QaSkillsError("Cross-run duplicate source snapshot does not match its trusted workspace artifact", "ARTIFACT_BINDING");
            }
          } finally { await comparison.close(); }
        }
      }
    } else if (type === "incident") {
      const testResults = await this.readRegisteredValues(manifest, "test-result");
      const attempt = testResults.find((result) => result.attemptId === value.attemptId);
      const expectedKind = attempt?.failureClassification === "TEST_DEFECT" ? "TEST_INCIDENT"
        : attempt?.failureClassification === "ENVIRONMENT_DEFECT" ? "ENVIRONMENT_INCIDENT"
          : attempt?.failureClassification === "UNDETERMINED" ? "INVESTIGATION_FINDING" : undefined;
      if (!attempt || attempt.status === "PASSED" || value.kind !== expectedKind) throw new QaSkillsError("Incident kind must derive from a registered non-product attempt", "ARTIFACT_BINDING");
      const evidenceItems = await this.readRegisteredValues(manifest, "evidence");
      const gaps = await this.readRegisteredValues(manifest, "evidence-gap");
      const validEvidence = Array.isArray(value.evidenceIds) && value.evidenceIds.length > 0 && value.evidenceIds.every((id) => evidenceItems.some((evidence) => evidence.evidenceId === id && evidence.attemptId === value.attemptId && evidence.runId === this.runId));
      const validGap = Array.isArray(value.evidenceGapIds) && value.evidenceGapIds.length > 0 && value.evidenceGapIds.every((id) => gaps.some((gap) => gap.attemptId === value.attemptId && gap.runId === this.runId && gap.evidenceGapId === id));
      if (!validEvidence && !validGap) {
        throw new QaSkillsError("Incident requires registered evidence or an evidence gap for its exact attempt", "ARTIFACT_BINDING");
      }
    } else if (type === "release-gate") {
      const derived = deriveReleaseGateFromWorkspaceArtifacts(await this.readGateWorkspaceArtifacts(manifest));
      if (value.runId !== this.runId || JSON.stringify(value.sourceArtifacts) !== JSON.stringify(derived.sourceArtifacts)
        || JSON.stringify(value.ruleInputs) !== JSON.stringify(derived.ruleInputs) || JSON.stringify(value.verdicts) !== JSON.stringify(derived.verdicts)
        || value.recommendation !== derived.recommendation) {
        throw new QaSkillsError("Release gate must equal the complete workspace-derived fact snapshot", "ARTIFACT_BINDING");
      }
    } else if (type === "qa-execution-report") {
      const gates = await this.readRegisteredValues(manifest, "release-gate");
      const gate = gates[0];
      const expectedGate = gate === undefined ? undefined : { sourceArtifacts: gate.sourceArtifacts, recommendation: gate.recommendation, ruleInputs: gate.ruleInputs, verdicts: gate.verdicts };
      if (gates.length !== 1 || !isRecord(value.releaseGate) || value.releaseRecommendation !== value.releaseGate.recommendation
        || gate?.recommendation !== value.releaseRecommendation || stableJson(value.releaseGate) !== stableJson(expectedGate)) {
        throw new QaSkillsError("QA report must reference the single registered deterministic release gate", "ARTIFACT_BINDING");
      }
    } else if (type === "test-data-manifest") {
      const resources = value.resources;
      if (!uniqueResourceIds(resources) || !resources.every((resource) => resource.ownerRunId === this.runId)) {
        throw new QaSkillsError("Test data resource owner run does not match this workspace", "ARTIFACT_BINDING");
      }
    } else if (type === "cleanup-run") {
      if (value.runId !== this.runId || typeof value.sourceRunId !== "string" || value.sourceRunId === this.runId || value.sourceRunId !== this.metadata.linkedRunId) {
        throw new QaSkillsError("Cleanup run must be linked to a distinct immutable source run", "ARTIFACT_BINDING");
      }
      try {
        await assertCleanupProvenance(this.path, value);
      } catch (error: unknown) {
        throw new QaSkillsError(error instanceof Error ? error.message : "Cleanup provenance is invalid", "ARTIFACT_BINDING");
      }
    } else if (type === "exploration-charter") {
      const environment = manifest.artifacts.find((artifact) => artifact.type === "environment-profile");
      if (value.runId !== this.runId || manifest.artifacts.some((artifact) => artifact.type === "exploration-charter") || !environment || relationships.length !== 1 || relationships[0] !== environment.id) {
        throw new QaSkillsError("An exploratory run requires exactly one runtime-bound charter", "ARTIFACT_BINDING");
      }
    } else if (type === "regression-selection") {
      if (value.runId !== this.runId) throw new QaSkillsError("Regression selection run ID does not match this workspace", "ARTIFACT_BINDING");
      const cases = await this.readRegisteredValues(manifest, "test-case");
      const decisions = [...array(value.selected), ...array(value.excluded)];
      const caseRecords = manifest.artifacts.filter((artifact) => artifact.type === "test-case");
      const expectedRelationships = decisions.map((decision) => isRecord(decision) ? caseRecords.find((candidate) => {
        const index = caseRecords.findIndex((record) => record.id === candidate.id);
        const testCase = cases[index];
        return testCase?.testCaseId === decision.testCaseId && testCase?.revisionId === decision.revisionId;
      })?.id : undefined);
      const scope = manifest.artifacts.find((artifact) => artifact.id === value.changeScopeArtifactId && artifact.type === "change-scope");
      const scopeValue = scope === undefined ? undefined : (await this.readRegisteredValues(manifest, "change-scope"))[manifest.artifacts.filter((artifact) => artifact.type === "change-scope").findIndex((artifact) => artifact.id === scope.id)];
      const recomputed = scopeValue && Array.isArray(scopeValue.changes) ? selectRegressionCases({ changes: scopeValue.changes as never, testCases: cases.map((testCase) => regressionCaseFromCanonical(testCase)) }) : undefined;
      const stored = { selected: value.selected, excluded: value.excluded, unmappedChangeRisks: value.unmappedChangeRisks, complete: value.complete };
      if (!scope || scope.sha256 !== value.changeScopeSha256 || value.decisionChecksum !== sha256Text(JSON.stringify(stored)) || recomputed === undefined || stableJson(stored) !== stableJson(recomputed) || !decisions.every((decision) => isRecord(decision) && cases.some((testCase) => testCase.testCaseId === decision.testCaseId && testCase.revisionId === decision.revisionId)) || expectedRelationships.some((id) => id === undefined) || JSON.stringify([...relationships].sort()) !== JSON.stringify([scope.id, ...expectedRelationships.filter((id): id is string => id !== undefined)].sort())) {
        throw new QaSkillsError("Regression selection decisions must bind registered canonical test case revisions", "ARTIFACT_BINDING");
      }
      if (value.complete === true && Array.isArray(value.unmappedChangeRisks) && value.unmappedChangeRisks.length > 0) {
        throw new QaSkillsError("Unmapped change risks prevent a complete regression claim", "ARTIFACT_BINDING");
      }
    } else if (type === "retest-result") {
      if (value.runId !== this.runId || value.sourceRunId !== this.metadata.linkedRunId || typeof value.sourceRunId !== "string" || value.sourceRunId === this.runId) {
        throw new QaSkillsError("Retest result must bind this linked immutable source run", "ARTIFACT_BINDING");
      }
      const source = await RunWorkspace.open(this.root, value.sourceRunId);
      try {
        const sourceArtifacts = await source.readRegisteredArtifacts();
        const bug = sourceArtifacts.find((artifact) => artifact.record.id === value.sourceBugArtifactId && artifact.record.type === "bug-report");
        if (!bug || bug.value.bugId !== value.bugId || typeof bug.value.attemptId !== "string") throw new QaSkillsError("Retest result source bug is not registered", "ARTIFACT_BINDING");
        const original = sourceArtifacts.find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === bug.value.attemptId);
        const attempts = await this.readRegisteredValues(manifest, "test-result");
        const ids = Array.isArray(value.reproductionAttemptIds) ? value.reproductionAttemptIds : [];
        const reproduced = ids.map((id) => attempts.find((attempt) => attempt.attemptId === id));
        if (!original || reproduced.length === 0 || reproduced.some((attempt) => !attempt || attempt.testCaseId !== original.value.testCaseId || attempt.testCaseRevisionId !== original.value.testCaseRevisionId || attempt.testCaseInstanceId !== original.value.testCaseInstanceId)) {
          throw new QaSkillsError("Retest result must use exact registered reproduction attempts", "ARTIFACT_BINDING");
        }
        const regressionIds = Array.isArray(value.regressionAttemptIds) ? value.regressionAttemptIds : [];
        const regression = regressionIds.map((id) => attempts.find((attempt) => attempt?.attemptId === id));
        const scenarios = Array.isArray(value.reproductionScenarios) ? value.reproductionScenarios : [];
        const scenarioValid = scenarios.length === reproduced.length && scenarios.every((scenario, index) => isRecord(scenario) && scenario.attemptId === ids[index] && scenario.status === reproduced[index]?.status && typeof scenario.scenarioId === "string");
        const regressionOutcome = deriveRegressionOutcome(regression.map((attempt) => String(attempt?.status)));
        const derived = deriveRetestVerdict({ originalBugId: String(bug.value.bugId), reproductionStatuses: scenarios.map((scenario) => String(isRecord(scenario) ? scenario.status : "")), scenarioIds: scenarios.map((scenario) => String(isRecord(scenario) ? scenario.scenarioId : "")), regressionOutcome });
        const resultRecords = manifest.artifacts.filter((artifact) => artifact.type === "test-result");
        const expectedRelationships = ids.map((id) => {
          const index = attempts.findIndex((attempt) => attempt?.attemptId === id);
          return index < 0 ? undefined : resultRecords[index]?.id;
        }).filter((id): id is string => id !== undefined).sort();
        const regressionRelationships = regressionIds.map((id) => {
          const index = attempts.findIndex((attempt) => attempt?.attemptId === id);
          return index < 0 ? undefined : resultRecords[index]?.id;
        }).filter((id): id is string => id !== undefined).sort();
        if (!scenarioValid || regression.some((attempt) => !attempt) || value.regressionOutcome !== regressionOutcome || value.verdict !== derived.verdict || JSON.stringify([...relationships].sort()) !== JSON.stringify([...expectedRelationships, ...regressionRelationships].sort())) throw new QaSkillsError("Retest verdict and relationships must derive from the exact reproduction independently of regression", "ARTIFACT_BINDING");
      } finally { await source.close(); }
    }
  }

  private async assertCoverageObligationBinding(value: Record<string, unknown>, manifest: Manifest): Promise<void> {
    if (typeof value.requirementId !== "string" || typeof value.requirementAnalysisArtifactId !== "string") {
      throw new QaSkillsError("Coverage obligation requirement binding is invalid", "ARTIFACT_BINDING");
    }
    const record = manifest.artifacts.find((artifact) => artifact.id === value.requirementAnalysisArtifactId && artifact.type === "requirement-analysis");
    if (!record) throw new QaSkillsError("Coverage obligation references an orphan requirement analysis artifact", "ARTIFACT_BINDING");
    const analyses = await this.readRegisteredValues(manifest, "requirement-analysis");
    const index = manifest.artifacts.filter((artifact) => artifact.type === "requirement-analysis").findIndex((artifact) => artifact.id === record.id);
    const analysis = analyses[index];
    const statements = analysis?.statements;
    if (!Array.isArray(statements) || statements.filter((statement) => isRecord(statement) && statement.requirementId === value.requirementId).length !== 1) {
      throw new QaSkillsError("Coverage obligation references an orphan or ambiguous requirement", "ARTIFACT_BINDING");
    }
  }

  private async withDerivedTestPlanApproval(value: unknown, manifest: Manifest): Promise<Record<string, unknown>> {
    if (!isRecord(value)) throw new QaSkillsError("Test plan policy is invalid", "ARTIFACT_BINDING");
    if (value.approvalDecision !== undefined) {
      throw new QaSkillsError("Test plan approval decision is derived by workspace registration and cannot be self-asserted", "ARTIFACT_BINDING");
    }
    const decision = await this.assertTestPlanPolicy(value, manifest);
    return { ...value, approvalDecision: decision };
  }

  private async assertTestPlanPolicy(value: Record<string, unknown>, manifest: Manifest): Promise<ApprovalDecision> {
    const requirements = await this.readRegisteredValues(manifest, "requirement-analysis");
    for (const analysis of requirements) {
      try {
        assertRequirementAuthorities(analysis);
      } catch (error: unknown) {
        throw new QaSkillsError(error instanceof Error ? error.message : "Registered requirement authority is invalid", "ARTIFACT_BINDING");
      }
    }
    const environments = await this.readRegisteredValues(manifest, "environment-profile");
    const environment = environments.length === 1 && typeof environments[0]?.classification === "string"
      ? { classification: environments[0].classification } as ApprovalEnvironment
      : undefined;
    if (!environment) throw new QaSkillsError("Test plan requires one authoritative environment profile", "ARTIFACT_BINDING");
    let decision: ApprovalDecision;
    try {
      decision = deriveTestPlanApproval({ plan: value, requirementAnalyses: requirements, environment });
    } catch (error: unknown) {
      throw new QaSkillsError(error instanceof Error ? error.message : "Test plan approval derivation failed", "ARTIFACT_BINDING");
    }
    const persisted = value.approvalDecision;
    if (persisted !== undefined && JSON.stringify(persisted) !== JSON.stringify(decision)) {
      throw new QaSkillsError("Persisted test plan approval decision does not equal the derived decision", "ARTIFACT_BINDING");
    }
    if (!decision.approved && isRecord(value.approvalPolicy) && value.approvalPolicy.mode === "auto-approve-safe") {
      throw new QaSkillsError(`Unsafe auto-approval: ${decision.reasons.join(", ")}`, "UNSAFE_OPERATION");
    }
    return decision;
  }

  private async registerCanonicalArtifact(
    type: ArtifactType,
    value: unknown,
    relationships: string[],
    provenance: string,
    currentManifest?: Manifest,
  ): Promise<ArtifactRecord & { absolutePath: string }> {
    const canonicalContents = `${JSON.stringify(value, null, 2)}\n`;
    const checksum = sha256Text(canonicalContents);
    const manifest = currentManifest ?? await this.readManifest();
    if (manifest.artifacts.some((artifact) => artifact.type === type && artifact.sha256 === checksum)) {
      throw new QaSkillsError("Completed artifacts are immutable; duplicate artifact", "DUPLICATE_ARTIFACT");
    }
    const id = createEntityId();
    const relativePath = `inputs/${id}-${type}.json`;
    const absolutePath = resolveWithin(this.path, relativePath);
    await this.persistence.writeAtomic(this.path, absolutePath, canonicalContents);
    if (await sha256(absolutePath) !== checksum) {
      throw new QaSkillsError("Atomic artifact write checksum mismatch", "WRITE_FAILURE");
    }
    const record: ArtifactRecord = {
      id,
      type,
      relativePath,
      sha256: checksum,
      provenance,
      relationships: [...relationships],
    };
    try {
      await this.writeManifest({ ...manifest, artifacts: [...manifest.artifacts, record] });
    } catch (error: unknown) {
      await rm(absolutePath, { force: true });
      throw error;
    }
    return { ...record, absolutePath };
  }

  private async readManifest(): Promise<Manifest> {
    const path = await assertRealpathWithin(this.path, "artifact-manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8")) as Manifest;
    if (!validateArtifact("artifact-manifest", manifest).valid) {
      throw new QaSkillsError("Invalid artifact manifest", "INVALID_MANIFEST");
    }
    if (manifest.runId !== this.runId) {
      throw new QaSkillsError("Manifest run ID does not match this workspace", "ARTIFACT_BINDING");
    }
    return manifest;
  }

  private async persistMetadata(metadata: WorkspaceMetadata): Promise<void> {
    await this.persistence.writeAtomic(
      this.path,
      resolveWithin(this.path, "run-metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  }

  private async writeManifest(manifest: Manifest): Promise<void> {
    await this.persistence.writeAtomic(
      this.path,
      resolveWithin(this.path, "artifact-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
}
