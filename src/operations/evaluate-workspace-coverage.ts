import { indexByTestCaseIdentity } from "../core/artifact-index.js";
import { QaSkillsError } from "../core/errors.js";
import { creditsCoverage } from "../core/provenance.js";
import { RunWorkspace, type RegisteredWorkspaceArtifact } from "../core/run-workspace.js";
import { array, isRecord } from "../core/values.js";
import {
  evaluateCoverage,
  type CoverageAttempt,
  type CoverageEvaluation,
  type CoverageObligation,
  type ResolvedCoverageObligation,
} from "../planning/coverage.js";

type RequirementStatement = { requirementId: string; authority: string };
type CoverageDimensions = Omit<CoverageObligation, "obligationId" | "required">;

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new QaSkillsError(`Registered ${label} is invalid`, "ARTIFACT_BINDING");
  return value;
}

function asObligation(value: Readonly<Record<string, unknown>>): CoverageObligation {
  const viewport = value.viewport;
  if (!isRecord(viewport) || typeof viewport.width !== "number" || typeof viewport.height !== "number") {
    throw new QaSkillsError("Registered coverage obligation viewport is invalid", "ARTIFACT_BINDING");
  }
  return {
    obligationId: requireString(value.obligationId, "coverage obligation ID"), requirementId: requireString(value.requirementId, "coverage obligation requirement ID"),
    role: requireString(value.role, "coverage obligation role"), behavior: requireString(value.behavior, "coverage obligation behavior"), browser: requireString(value.browser, "coverage obligation browser"),
    viewport: { width: viewport.width, height: viewport.height }, accessibilityMethod: typeof value.accessibilityMethod === "string" ? value.accessibilityMethod : undefined,
    risk: requireString(value.risk, "coverage obligation risk"), required: value.required === true, outcome: requireString(value.outcome, "coverage obligation outcome"),
  };
}

function dimensions(value: Readonly<Record<string, unknown>>): CoverageDimensions {
  const coverage = value.coverage;
  if (!isRecord(coverage)) throw new QaSkillsError("Registered test case has no immutable coverage dimensions", "ARTIFACT_BINDING");
  return asObligation({ ...coverage, obligationId: "resolved", required: true });
}

function requirementAuthority(artifacts: readonly RegisteredWorkspaceArtifact[], analysisId: string, requirementId: string): string {
  const analysis = artifacts.find((artifact) => artifact.record.id === analysisId && artifact.record.type === "requirement-analysis");
  const statements = analysis?.value.statements;
  if (!Array.isArray(statements)) throw new QaSkillsError("Coverage obligation references an orphan requirement analysis", "ARTIFACT_BINDING");
  const matches = statements.filter((statement): statement is RequirementStatement => isRecord(statement)
    && statement.requirementId === requirementId && typeof statement.authority === "string");
  if (matches.length !== 1) throw new QaSkillsError("Coverage obligation references an orphan or ambiguous requirement", "ARTIFACT_BINDING");
  return matches[0]?.authority ?? "";
}

function resolveObligation(artifacts: readonly RegisteredWorkspaceArtifact[], value: Readonly<Record<string, unknown>>): ResolvedCoverageObligation {
  const obligation = asObligation(value);
  const analysisId = requireString(value.requirementAnalysisArtifactId, "coverage obligation requirement analysis artifact ID");
  return { ...obligation, authoritativeRequirement: requirementAuthority(artifacts, analysisId, obligation.requirementId) === "AUTHORITATIVE" };
}

/** Resolves coverage from revalidated registered workspace records; caller strings only locate that workspace. */
export async function evaluateWorkspaceCoverage(options: { root: string; runId: string; /** Internal runtime seam for an already-locked active run. */ workspace?: RunWorkspace }): Promise<CoverageEvaluation> {
  const workspace = options.workspace ?? await RunWorkspace.open(options.root, options.runId);
  const ownsWorkspace = options.workspace === undefined;
  try {
    const artifacts = await workspace.readRegisteredArtifacts();
    const obligations = artifacts.filter((artifact) => artifact.record.type === "coverage-obligation").map((artifact) => resolveObligation(artifacts, artifact.value));
    // `resolveDimensions` runs once per registered attempt and once per batch entry, so the test-case
    // scan it used to run is indexed once here. This function only reads (`artifacts` comes from the
    // single read above and nothing is registered before the try block ends), so the pool is invariant
    // for every consultation below.
    const casesByIdentity = indexByTestCaseIdentity(artifacts.filter((artifact) => artifact.record.type === "test-case"), (candidate) => ({ testCaseId: candidate.value.testCaseId, testCaseRevisionId: candidate.value.revisionId, testCaseInstanceId: candidate.value.instanceId }));
    /** `field` labels the malformed-field diagnostic, `subject` the orphan-binding one; both messages
     *  are preserved verbatim per source, so the per-attempt path's diagnostics are unchanged. */
    const resolveDimensions = (value: Readonly<Record<string, unknown>>, field: string, subject: string): CoverageDimensions => {
      const testCaseId = requireString(value.testCaseId, `${field} test case ID`);
      const revisionId = requireString(value.testCaseRevisionId, `${field} test case revision ID`);
      const instanceId = requireString(value.testCaseInstanceId, `${field} test case instance ID`);
      const matches = casesByIdentity.get({ testCaseId, testCaseRevisionId: revisionId, testCaseInstanceId: instanceId });
      if (matches.length !== 1) throw new QaSkillsError(`${subject} references an orphan or ambiguous test case revision and instance`, "ARTIFACT_BINDING");
      return dimensions(matches[0]?.value ?? {});
    };
    const attempts: CoverageAttempt[] = artifacts
      .filter((artifact) => artifact.record.type === "test-result" && creditsCoverage(artifact.record.provenance))
      .map((result) => ({
        attemptId: requireString(result.value.attemptId, "test result attempt ID"), status: requireString(result.value.status, "test result status"),
        ...resolveDimensions(result.value, "test result", "Test result"),
      }));
    // Lane 2 (ADR-0010): one `test-result-batch` per Runtime-Observed Execution flattens into one
    // CoverageAttempt per entry, keyed by `entryId` (an entry has no attempt — no attempt was driven).
    // Crediting is gated by the SAME provenance predicate, so an agent-draft batch credits nothing.
    const batchAttempts: CoverageAttempt[] = artifacts
      .filter((artifact) => artifact.record.type === "test-result-batch" && creditsCoverage(artifact.record.provenance))
      .flatMap((batch) => array(batch.value.entries).map((entry) => {
        if (!isRecord(entry)) throw new QaSkillsError("Registered test result batch entry is invalid", "ARTIFACT_BINDING");
        return {
          attemptId: requireString(entry.entryId, "test result batch entry ID"), status: requireString(entry.status, "test result batch entry status"),
          ...resolveDimensions(entry, "test result batch entry", "Test result batch entry"),
        };
      }));
    return evaluateCoverage(obligations, [...attempts, ...batchAttempts]);
  } finally {
    if (ownsWorkspace) await workspace.close();
  }
}
