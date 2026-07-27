import { assertExplorationCharter, type ExplorationCharter } from "../exploratory/charter.js";
import { deriveRegressionOutcome, deriveRetestVerdict, sourceScenarioId, type RegressionOutcome } from "../retest/verdict.js";
import { selectRegressionCases, type RegressionSelection } from "../regression/selector.js";
import { regressionCaseFromCanonical, type ChangeScope, type RegressionCase } from "../regression/change-scope.js";
import { sha256Text } from "../core/checksum.js";
import { QaSkillsError } from "../core/errors.js";
import { indexByAttemptId, indexByKey, indexByTestCaseIdentity, type ArtifactIndex, type TestCaseIdentity } from "../core/artifact-index.js";
import { evidenceAttemptId } from "../core/artifact-record.js";
import { RunWorkspace, type ArtifactRecord, type RegisteredWorkspaceArtifact, type WorkspaceValidation } from "../core/run-workspace.js";
import { isRecord, canonicalJson } from "../core/values.js";
import { operationsForMode, type PublicWorkflowMode, type WorkflowOperationName } from "../core/modes.js";
import type { Browser } from "@playwright/test";
import type { SecretResolver } from "../browser/types.js";
import { executeTestInstance } from "./execute-browser-test.js";
import { attachEvidence, captureEvidence, recordEvidenceGap, type TelemetryScrubber } from "../evidence/collector.js";
import { annotateScreenshot } from "../evidence/annotator.js";
import { normalizeGeometry } from "../evidence/geometry.js";
import { redactText } from "../evidence/redaction.js";
import { resolveLocator } from "../browser/locator.js";
import { resolveEvidencePolicy, type EvidencePolicyLayers } from "../evidence/policy.js";
import { profileDeclaresProtectedEnvironment, protectionDomSelectors, protectionRegions } from "../evidence/protection.js";
import { prepareTestData } from "./prepare-test-data.js";
import { TestDataHookRegistry } from "../test-data/hooks.js";
import { registerChangeScope } from "../regression/change-scope.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEntityId } from "../core/ids.js";
import { validateArtifact } from "../contracts/validator.js";
import type { ExternalPermitRegistry } from "../safety/external-permits.js";
import { evaluatePublicTerminalProfile } from "../core/artifact-profiles.js";
import { deriveTestPlanApproval, type ApprovalEnvironment } from "../planning/approval.js";
import type { ReleaseRecommendation } from "../reporting/release-gate.js";

/** Closed operation contracts: the public adapter cannot inject callbacks or untyped objects. */
export type WorkflowOperationInputMap = {
  "ingest-requirement-analysis": Readonly<{ workspace: RunWorkspace; input: QaWorkflowInput }>;
  "ingest-testcases": Readonly<{ workspace: RunWorkspace; input: QaWorkflowInput }>;
  "ingest-coverage-obligation": Readonly<{ workspace: RunWorkspace; input: QaWorkflowInput }>;
  "prepare-test-data": Readonly<{ workspace: RunWorkspace; input: QaWorkflowInput; runtime: QaRuntimeRegistry }>;
  "execute-browser-test": Readonly<{ workspace: RunWorkspace; input: QaWorkflowInput; runtime: QaRuntimeRegistry; caseArtifactIds: readonly string[] }>;
  "collect-evidence": Readonly<{ workspace: RunWorkspace; input: QaWorkflowInput; runtime: QaRuntimeRegistry; caseArtifactIds: readonly string[] }>;
  "generate-bug-report": Readonly<{ workspace: RunWorkspace; input: QaWorkflowInput }>;
  "generate-qa-report": Readonly<{ workspace: RunWorkspace; input: QaWorkflowInput }>;
  "register-exploration-charter": Readonly<{ workspace: RunWorkspace; input: QaWorkflowInput; charter: ExplorationCharter }>;
  "reproduce-bug": Readonly<{ workspace: RunWorkspace; input: QaWorkflowInput; runtime: QaRuntimeRegistry; scenarios: readonly RetestScenario[] }>;
  "select-regression": Readonly<{ workspace: RunWorkspace; input: QaWorkflowInput; runtime: QaRuntimeRegistry }>;
  "derive-retest-verdict": Readonly<{ workspace: RunWorkspace; input: QaWorkflowInput; source: RetestSource; reproductionAttemptIds: readonly string[]; regressionAttemptIds: readonly string[] }>;
};
export type WorkflowOperationOutputMap = {
  "ingest-requirement-analysis": readonly ArtifactRecord[];
  "ingest-testcases": readonly ArtifactRecord[];
  "ingest-coverage-obligation": readonly ArtifactRecord[];
  "prepare-test-data": ArtifactRecord;
  "execute-browser-test": readonly ArtifactRecord[];
  "collect-evidence": readonly ArtifactRecord[];
  "generate-bug-report": readonly ArtifactRecord[];
  "generate-qa-report": readonly ArtifactRecord[];
  "register-exploration-charter": ArtifactRecord;
  "reproduce-bug": readonly ArtifactRecord[];
  "select-regression": ArtifactRecord;
  "derive-retest-verdict": ArtifactRecord;
};
/** Outputs are a closed discriminated union of declared operation results. */
export type WorkflowOutput = WorkflowOperationOutputMap[WorkflowOperationName];
export type CorrelatedWorkflowOutputs = Partial<{ [Name in WorkflowOperationName]: WorkflowOperationOutputMap[Name] }>;
export type WorkflowOperation = (context: Readonly<{ name: WorkflowOperationName; workspace: RunWorkspace; input: WorkflowInput; outputs: Readonly<CorrelatedWorkflowOutputs> }>) => Promise<WorkflowOutput | void>;
export type WorkflowInput = Readonly<{
  root: string;
  mode: PublicWorkflowMode;
  environmentProfile: Record<string, unknown>;
  /** A caller may supply an active runtime-owned workspace containing canonical inputs. */
  workspace?: RunWorkspace;
  linkedRunId?: string;
  approvedRevisionArtifactIds?: readonly string[];
  charter?: ExplorationCharter;
  regression?: Readonly<{ changes: readonly ChangeScope[]; testCases: readonly RegressionCase[]; sourceRunId?: string }>;
  retest?: Readonly<{ sourceBugArtifactId: string; reproductionAttemptIds: readonly string[]; regressionOutcome?: RegressionOutcome }>;
}>;
export type WorkflowTerminalStatus = "COMPLETED" | "COMPLETED_WITH_FAILURES" | "BLOCKED" | "ABORTED";
export type WorkflowResult = Readonly<{ runId: string; mode: PublicWorkflowMode; outcome: "AWAITING_RUNTIME" | WorkflowTerminalStatus; operationOrder: readonly WorkflowOperationName[]; outputs: Readonly<CorrelatedWorkflowOutputs>; validation: WorkspaceValidation; releaseRecommendation?: ReleaseRecommendation }>;

/** A checksum-bound immutable source record.  Public workflows never accept a raw draft. */
export type RegisteredArtifactRef = Readonly<{ artifactId: string; sha256: string }>;
export type CanonicalPlanBundleRef = Readonly<{ sourceRunId: string; artifacts: readonly RegisteredArtifactRef[] }>;

function canonicalImportProvenance(sourceRunId: string, artifact: RegisteredArtifactRef): string {
  return `runtime-import:${sourceRunId}:${artifact.artifactId}:${artifact.sha256}`;
}
export type QaRuntimeRegistry = Readonly<{
  browserManagers?: Readonly<Record<string, Readonly<{ browser: Browser; annotateFailures?: boolean }>>>;
  secretResolvers?: Readonly<Record<string, SecretResolver>>;
  testDataRegistries?: Readonly<Record<string, TestDataHookRegistry>>;
  evidencePolicies?: Readonly<Record<string, EvidencePolicyLayers>>;
  telemetryScrubbers?: Readonly<Record<string, TelemetryScrubber>>;
  externalPermitRegistries?: Readonly<Record<string, ExternalPermitRegistry>>;
  changeScopeSources?: Readonly<Record<string, Readonly<{ changes: readonly ChangeScope[]; provenance: { kind: "git-diff" | "user-change" | "declared-change"; reference: string } }>>>;
}>;

/**
 * The public runtime boundary.  It contains only registered IDs and immutable
 * source references: no Browser object, callback, raw mapping, result claim,
 * or caller-selected attempt/outcome crosses this boundary.
 */
export type QaWorkflowInput = Readonly<{
  root: string;
  mode: PublicWorkflowMode;
  environmentProfile: Record<string, unknown>;
  bundle?: CanonicalPlanBundleRef;
  /** Reopens the same nonterminal run after its checkpointed runtime becomes available. */
  resumeRunId?: string;
  linkedRunId?: string;
  runtime?: Readonly<{ browserManagerId?: string; secretResolverId?: string; testDataRegistryId?: string; testDataHookIds?: readonly string[]; evidencePolicyId?: string; externalPermitRegistryId?: string; changeScopeSourceId?: string }>;
  charter?: ExplorationCharter;
  retest?: Readonly<{ sourceBug: RegisteredArtifactRef }>;
}>;

function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value as unknown[] : []; }

function artifactRecord(value: unknown): value is ArtifactRecord {
  return isRecord(value) && typeof value.id === "string" && typeof value.sha256 === "string" && typeof value.type === "string" && typeof value.relativePath === "string";
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new QaSkillsError(`Registered ${label} is invalid`, "ARTIFACT_BINDING");
  return value;
}

function workflowInputChecksum(input: QaWorkflowInput): string {
  return sha256Text(JSON.stringify({ mode: input.mode, environmentProfile: input.environmentProfile, bundle: input.bundle, linkedRunId: input.linkedRunId, testDataHookIds: input.runtime?.testDataHookIds, charter: input.charter, retest: input.retest }));
}

type WorkflowStateSnapshot = Readonly<{
  importedArtifacts: readonly RegisteredArtifactRef[];
  executionCases: readonly RegisteredArtifactRef[];
  selection?: RegisteredArtifactRef;
  retestSource?: Readonly<{ bugId: string; scenarios: readonly RetestScenario[] }>;
  reproductionAttempts: readonly RegisteredArtifactRef[];
  regressionAttempts: readonly RegisteredArtifactRef[];
  charter?: RegisteredArtifactRef;
  exploratoryFindings: readonly RegisteredArtifactRef[];
}>;
type WorkflowCheckpoint = Readonly<{ record: ArtifactRecord; completedOperations: readonly WorkflowOperationName[]; operationOutputs: Readonly<Record<string, readonly RegisteredArtifactRef[]>>; state: WorkflowStateSnapshot }>;

/** Mutable only for the duration of one runtime-owned workflow iteration. */
type WorkflowExecutionState = {
  readonly workspace: RunWorkspace;
  readonly input: QaWorkflowInput;
  readonly runtime: QaRuntimeRegistry;
  readonly outputs: CorrelatedWorkflowOutputs;
  checkpoint: WorkflowCheckpoint;
  executionCaseIds: string[];
  importedArtifactIds: string[];
  retestSource?: RetestSource;
  reproductionAttemptIds: string[];
  regressionAttemptIds: string[];
  selection?: RegressionSelection;
  charterArtifactId?: string;
  exploratoryFindingIds: string[];
};

type ClosedOperationAdapter<Name extends WorkflowOperationName> = Readonly<{
  name: Name;
  execute: (state: WorkflowExecutionState) => Promise<WorkflowOperationOutputMap[Name]>;
  assertPostcondition: (workspace: RunWorkspace, output: WorkflowOperationOutputMap[Name]) => Promise<void>;
}>;

/** The registered-artifact identity every scan in this module resolves first. Keyed on `record.id`
 *  alone; a call site that also compared `sha256` keeps that comparison against the returned bucket,
 *  which holds exactly the artifacts carrying that id, in registration order. */
function indexByArtifactId(artifacts: readonly RegisteredWorkspaceArtifact[]): ArtifactIndex<RegisteredWorkspaceArtifact> {
  return indexByKey(artifacts, (artifact) => artifact.record.id);
}

/** The identity triple as a `test-case` payload spells it (`revisionId` / `instanceId`), reconciled
 *  with the `testCaseRevisionId` / `testCaseInstanceId` names every probe site passes in. */
function testCaseIdentityOf(artifact: RegisteredWorkspaceArtifact): TestCaseIdentity {
  return { testCaseId: artifact.value.testCaseId, testCaseRevisionId: artifact.value.revisionId, testCaseInstanceId: artifact.value.instanceId };
}

function indexTestCasesByIdentity(artifacts: readonly RegisteredWorkspaceArtifact[]) {
  return indexByTestCaseIdentity(artifacts.filter((artifact) => artifact.record.type === "test-case"), testCaseIdentityOf);
}

function indexResultsByAttempt(artifacts: readonly RegisteredWorkspaceArtifact[]): ArtifactIndex<RegisteredWorkspaceArtifact> {
  return indexByAttemptId(artifacts.filter((artifact) => artifact.record.type === "test-result"), (artifact) => artifact.value.attemptId);
}

async function assertRegisteredArtifacts(workspace: RunWorkspace, output: WorkflowOutput | readonly ArtifactRecord[]): Promise<void> {
  const records = Array.isArray(output) ? output.filter(artifactRecord) : artifactRecord(output) ? [output] : [];
  const artifacts = await workspace.readRegisteredArtifacts();
  // Invariance: `artifacts` is read here and this postcondition registers nothing.
  const byId = indexByArtifactId(artifacts);
  if (records.some((item) => !byId.get(item.id).some((artifact) => artifact.record.sha256 === item.sha256))) throw new QaSkillsError("Workflow operation output is not a registered immutable artifact", "ARTIFACT_BINDING");
}

async function assertEvidencePostcondition(workspace: RunWorkspace, output: readonly ArtifactRecord[]): Promise<void> {
  await assertRegisteredArtifacts(workspace, output);
  if (output.length === 0) throw new QaSkillsError("Runtime execution postcondition requires result evidence or an evidence gap", "ARTIFACT_BINDING");
  if (!output.some((artifact) => artifact.type === "evidence" || artifact.type === "evidence-gap")) throw new QaSkillsError("Evidence operation must register evidence or an evidence gap", "ARTIFACT_BINDING");
}

async function assertResultPostcondition(workspace: RunWorkspace, output: readonly ArtifactRecord[]): Promise<void> {
  await assertRegisteredArtifacts(workspace, output);
  if (output.length === 0 || output.some((item) => item.type !== "test-result")) throw new QaSkillsError("Execution operation must return registered test-result references", "ARTIFACT_BINDING");
  const artifacts = await workspace.readRegisteredArtifacts();
  // Invariance: `artifacts` is read here and this postcondition registers nothing, so both indices serve
  // every iteration of the loop below. Evidence carries its attempt inside the `subject` union while an
  // Evidence Gap still carries it flat, so the two types are keyed by their own accessor into one index
  // — the `.some()` this replaces admitted exactly those two types and nothing else.
  const byId = indexByArtifactId(artifacts);
  const attestationsByAttempt = indexByAttemptId(
    artifacts.filter((item) => item.record.type === "evidence" || item.record.type === "evidence-gap"),
    (item) => item.record.type === "evidence" ? evidenceAttemptId(item.value) : String(item.value.attemptId),
  );
  for (const result of output) {
    const attempt = byId.get(result.id)[0];
    const attemptId = attempt === undefined ? undefined : String(attempt.value.attemptId);
    if (!attemptId || attestationsByAttempt.get(attemptId).length === 0) throw new QaSkillsError("Execution result lacks registered evidence or evidence gap", "ARTIFACT_BINDING");
  }
}

async function assertFailureDispositionPostcondition(workspace: RunWorkspace, output: readonly ArtifactRecord[]): Promise<void> {
  await assertRegisteredArtifacts(workspace, output);
  const artifacts = await workspace.readRegisteredArtifacts();
  const failed = artifacts.filter((artifact) => artifact.record.type === "test-result" && artifact.value.status === "FAILED");
  // Invariance: `artifacts` is read here and this postcondition registers nothing. Keys stay RAW so the
  // lookup admits exactly what `artifact.value.attemptId === attempt.value.attemptId` admitted.
  const dispositionsByAttempt = indexByAttemptId(
    artifacts.filter((artifact) => artifact.record.type === "bug-report" || artifact.record.type === "incident"),
    (artifact) => artifact.value.attemptId,
  );
  const unresolved = failed.filter((attempt) => dispositionsByAttempt.get(attempt.value.attemptId).length === 0);
  if (unresolved.length > 0) throw new QaSkillsError("Every failed attempt must have an eligible bug or typed incident disposition", "ARTIFACT_BINDING");
}

/** The production adapter is closed: every public operation has one declared postcondition. */
const closedOperationAdapters: { readonly [Name in WorkflowOperationName]: ClosedOperationAdapter<Name> } = {
  "ingest-requirement-analysis": { name: "ingest-requirement-analysis", execute: (state) => runClosedOperation(state, "ingest-requirement-analysis"), assertPostcondition: assertRegisteredArtifacts },
  "ingest-testcases": { name: "ingest-testcases", execute: (state) => runClosedOperation(state, "ingest-testcases"), assertPostcondition: assertRegisteredArtifacts },
  "ingest-coverage-obligation": { name: "ingest-coverage-obligation", execute: (state) => runClosedOperation(state, "ingest-coverage-obligation"), assertPostcondition: async () => {} },
  "prepare-test-data": { name: "prepare-test-data", execute: (state) => runClosedOperation(state, "prepare-test-data"), assertPostcondition: async (workspace) => { if (!(await workspace.readRegisteredArtifacts()).some((artifact) => artifact.record.type === "test-data-manifest")) throw new QaSkillsError("Test-data operation must register its manifest", "ARTIFACT_BINDING"); } },
  "execute-browser-test": { name: "execute-browser-test", execute: (state) => runClosedOperation(state, "execute-browser-test"), assertPostcondition: assertResultPostcondition },
  "collect-evidence": { name: "collect-evidence", execute: (state) => runClosedOperation(state, "collect-evidence"), assertPostcondition: assertEvidencePostcondition },
  "generate-bug-report": { name: "generate-bug-report", execute: (state) => runClosedOperation(state, "generate-bug-report"), assertPostcondition: assertFailureDispositionPostcondition },
  "generate-qa-report": { name: "generate-qa-report", execute: (state) => runClosedOperation(state, "generate-qa-report"), assertPostcondition: async (workspace) => { if (!(await workspace.readRegisteredArtifacts()).some((artifact) => artifact.record.type === "qa-execution-report")) throw new QaSkillsError("QA report operation must register its report", "ARTIFACT_BINDING"); } },
  "register-exploration-charter": { name: "register-exploration-charter", execute: (state) => runClosedOperation(state, "register-exploration-charter"), assertPostcondition: assertRegisteredArtifacts },
  "reproduce-bug": { name: "reproduce-bug", execute: (state) => runClosedOperation(state, "reproduce-bug"), assertPostcondition: assertResultPostcondition },
  "select-regression": { name: "select-regression", execute: (state) => runClosedOperation(state, "select-regression"), assertPostcondition: assertRegisteredArtifacts },
  "derive-retest-verdict": { name: "derive-retest-verdict", execute: (state) => runClosedOperation(state, "derive-retest-verdict"), assertPostcondition: assertRegisteredArtifacts },
};

export function workflowOperationAdaptersForTests(): typeof closedOperationAdapters { return closedOperationAdapters; }

function emptyWorkflowState(): WorkflowStateSnapshot {
  return { importedArtifacts: [], executionCases: [], reproductionAttempts: [], regressionAttempts: [], exploratoryFindings: [] };
}

function workflowStateChecksum(state: WorkflowStateSnapshot): string { return sha256Text(canonicalJson(state)); }

function registeredRef(byId: ArtifactIndex<RegisteredWorkspaceArtifact>, id: string | undefined): RegisteredArtifactRef | undefined {
  const artifact = id === undefined ? undefined : byId.get(id)[0];
  return artifact === undefined ? undefined : { artifactId: artifact.record.id, sha256: artifact.record.sha256 };
}

async function snapshotWorkflowState(state: WorkflowExecutionState): Promise<WorkflowStateSnapshot> {
  const artifacts = await state.workspace.readRegisteredArtifacts();
  // Invariance: `artifacts` is read here and this function only READS — the checkpoint that records this
  // snapshot is registered by `advanceCheckpoint` after this call returns, so both indices describe the
  // pool every scan below used to walk.
  const byId = indexByArtifactId(artifacts);
  const resultsByAttempt = indexResultsByAttempt(artifacts);
  const refs = (ids: readonly string[]) => ids.map((id) => registeredRef(byId, id)).filter((item): item is RegisteredArtifactRef => item !== undefined);
  const selectedExecutionCases = state.selection === undefined ? state.executionCaseIds : selectedCaseArtifactIds(state.selection, artifacts);
  if (state.selection !== undefined && selectedExecutionCases.length !== state.selection.selected.length) throw new QaSkillsError("Regression selection does not resolve every selected canonical testcase", "ARTIFACT_BINDING");
  return {
    importedArtifacts: refs(state.importedArtifactIds), executionCases: refs(selectedExecutionCases),
    reproductionAttempts: refs(state.reproductionAttemptIds.map((attemptId) => resultsByAttempt.get(attemptId)[0]?.record.id).filter((id): id is string => id !== undefined)),
    regressionAttempts: refs(state.regressionAttemptIds.map((attemptId) => resultsByAttempt.get(attemptId)[0]?.record.id).filter((id): id is string => id !== undefined)),
    exploratoryFindings: refs(state.exploratoryFindingIds),
    ...(state.selection === undefined ? {} : { selection: registeredRef(byId, artifacts.find((item) => item.record.type === "regression-selection")?.record.id)! }),
    ...(state.retestSource === undefined ? {} : { retestSource: state.retestSource }),
    ...(state.charterArtifactId === undefined ? {} : { charter: registeredRef(byId, state.charterArtifactId)! }),
  };
}

function checkpointState(value: unknown): WorkflowStateSnapshot {
  if (!isRecord(value)) throw new QaSkillsError("Workflow checkpoint state is invalid", "ARTIFACT_BINDING");
  const refs = (key: string): readonly RegisteredArtifactRef[] => Array.isArray(value[key]) && value[key].every((item) => isRecord(item) && typeof item.artifactId === "string" && typeof item.sha256 === "string") ? value[key] as RegisteredArtifactRef[] : (() => { throw new QaSkillsError("Workflow checkpoint state references are invalid", "ARTIFACT_BINDING"); })();
  const ref = (key: string): RegisteredArtifactRef | undefined => value[key] === undefined ? undefined : isRecord(value[key]) && typeof value[key].artifactId === "string" && typeof value[key].sha256 === "string" ? value[key] as RegisteredArtifactRef : (() => { throw new QaSkillsError("Workflow checkpoint state reference is invalid", "ARTIFACT_BINDING"); })();
  return { importedArtifacts: refs("importedArtifacts"), executionCases: refs("executionCases"), reproductionAttempts: refs("reproductionAttempts"), regressionAttempts: refs("regressionAttempts"), exploratoryFindings: refs("exploratoryFindings"), ...(ref("selection") === undefined ? {} : { selection: ref("selection")! }), ...(ref("charter") === undefined ? {} : { charter: ref("charter")! }), ...(value.retestSource === undefined ? {} : { retestSource: value.retestSource as RetestSource }) };
}

async function checkpointWorkflow(workspace: RunWorkspace, input: QaWorkflowInput): Promise<WorkflowCheckpoint> {
  const checkpoints = (await workspace.readRegisteredArtifacts()).filter((artifact) => artifact.record.type === "workflow-checkpoint");
  const checksum = workflowInputChecksum(input);
  if (checkpoints.length > 0) {
    const latest = [...checkpoints].sort((left, right) => Number(right.value.revision) - Number(left.value.revision))[0];
    if (!latest || latest.value.inputChecksum !== checksum) throw new QaSkillsError("Resume input does not match its durable workflow checkpoint", "ARTIFACT_BINDING");
    return { record: latest.record, completedOperations: Array.isArray(latest.value.completedOperations) ? latest.value.completedOperations as WorkflowOperationName[] : [], operationOutputs: isRecord(latest.value.operationOutputs) ? latest.value.operationOutputs as Record<string, readonly RegisteredArtifactRef[]> : {}, state: checkpointState(latest.value.state) };
  }
  const created = await workspace.registerArtifactValue({ type: "workflow-checkpoint", value: {
    artifactType: "workflow-checkpoint", schemaVersion: "1.0.0", producerVersion: "0.1.0", checkpointId: `CHK-${workspace.runId}`, runId: workspace.runId, mode: input.mode,
    inputChecksum: checksum, revision: 1, completedOperations: [], operationOutputs: {}, state: emptyWorkflowState(), stateChecksum: workflowStateChecksum(emptyWorkflowState()), ...(input.bundle === undefined ? {} : { bundle: { sourceRunId: input.bundle.sourceRunId, artifacts: input.bundle.artifacts.map((artifact) => ({ artifactId: artifact.artifactId, sha256: artifact.sha256 })) } }),
  }, relationships: [], provenance: "runtime" });
  return { record: created, completedOperations: [], operationOutputs: {}, state: emptyWorkflowState() };
}

async function advanceCheckpoint(workspace: RunWorkspace, input: QaWorkflowInput, previous: WorkflowCheckpoint, operation: WorkflowOperationName, output: WorkflowOutput | readonly ArtifactRecord[], state: WorkflowExecutionState): Promise<WorkflowCheckpoint> {
  if (previous.completedOperations.includes(operation)) return previous;
  const records: readonly ArtifactRecord[] = Array.isArray(output) ? output.filter(artifactRecord) : artifactRecord(output) ? [output] : [];
  const operationOutputs: Record<string, readonly RegisteredArtifactRef[]> = { ...previous.operationOutputs, [operation]: records.map((artifact) => ({ artifactId: artifact.id, sha256: artifact.sha256 })) };
  const snapshot = await snapshotWorkflowState(state);
  const registered = await workspace.registerArtifactValue({ type: "workflow-checkpoint", value: {
    artifactType: "workflow-checkpoint", schemaVersion: "1.0.0", producerVersion: "0.1.0", checkpointId: `CHK-${workspace.runId}`, runId: workspace.runId, mode: input.mode, inputChecksum: workflowInputChecksum(input), revision: Number((await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.id === previous.record.id)?.value.revision) + 1,
    supersedesArtifactId: previous.record.id, completedOperations: [...previous.completedOperations, operation], operationOutputs, state: snapshot, stateChecksum: workflowStateChecksum(snapshot),
    ...(input.bundle === undefined ? {} : { bundle: { sourceRunId: input.bundle.sourceRunId, artifacts: input.bundle.artifacts.map((artifact) => ({ artifactId: artifact.artifactId, sha256: artifact.sha256 })) } }),
  }, relationships: [previous.record.id, ...records.map((artifact) => artifact.id)], provenance: "runtime" });
  return { record: registered, completedOperations: [...previous.completedOperations, operation], operationOutputs, state: snapshot };
}

function missingRuntimeLabel(runtime: QaRuntimeRegistry, input: QaWorkflowInput): string | undefined {
  if (["full", "execute", "regression", "retest", "exploratory"].includes(input.mode) && (!input.runtime?.browserManagerId || !runtime.browserManagers?.[input.runtime.browserManagerId])) return "browser manager";
  if (input.mode === "full" && (!input.runtime?.testDataRegistryId || !runtime.testDataRegistries?.[input.runtime.testDataRegistryId])) return "test-data registry";
  return undefined;
}

type CanonicalPlanImportType = "requirement-analysis" | "test-plan" | "test-case" | "coverage-obligation";
type CanonicalPlanImportItem = Readonly<{
  key: string;
  type: CanonicalPlanImportType;
  value: Record<string, unknown>;
  relationshipKeys: readonly string[];
  referenceFields?: Readonly<Record<string, string>>;
  provenance: string;
}>;

/** Rebuild the exact canonical target batch from a checked terminal source bundle. */
async function buildCanonicalPlanImportBatch(workspace: RunWorkspace, bundle: CanonicalPlanBundleRef): Promise<readonly CanonicalPlanImportItem[]> {
  if (bundle.sourceRunId === workspace.runId || bundle.artifacts.length === 0 || new Set(bundle.artifacts.map((item) => item.artifactId)).size !== bundle.artifacts.length) {
    throw new QaSkillsError("Canonical plan bundle reference is invalid", "ARTIFACT_BINDING");
  }
  const metadata = JSON.parse(await readFile(join(workspace.root, "qa-results", bundle.sourceRunId, "run-metadata.json"), "utf8")) as Record<string, unknown>;
  if (!["COMPLETED", "COMPLETED_WITH_FAILURES", "BLOCKED", "ABORTED"].includes(String(metadata.status))) throw new QaSkillsError("Canonical plan bundle source must be terminal", "ARTIFACT_BINDING");
  const source = await RunWorkspace.open(workspace.root, bundle.sourceRunId);
  try {
    const requested = new Map(bundle.artifacts.map((item) => [item.artifactId, item.sha256]));
    const loaded = await source.readRegisteredArtifacts();
    const records = await Promise.all([...requested.keys()].map((id) => source.readArtifactRecord(id)));
    for (const sourceRecord of records) {
      if (requested.get(sourceRecord.id) !== sourceRecord.sha256) throw new QaSkillsError("Canonical plan bundle checksum does not match its registered source record", "ARTIFACT_BINDING");
    }
    const selected = loaded.filter((item) => requested.has(item.record.id));
    if (selected.length !== requested.size) throw new QaSkillsError("Canonical plan bundle references an unknown source record", "ARTIFACT_BINDING");
    const accepted = new Set<CanonicalPlanImportType>(["requirement-analysis", "test-plan", "test-case", "coverage-obligation"]);
    if (selected.some((item) => !accepted.has(item.record.type as CanonicalPlanImportType))) throw new QaSkillsError("Canonical plan bundle contains a non-planning artifact", "ARTIFACT_BINDING");
    for (const type of accepted) if (!selected.some((item) => item.record.type === type)) throw new QaSkillsError(`Canonical plan bundle is incomplete: missing ${type}`, "ARTIFACT_BINDING");
    const selectedIds = new Set(selected.map((item) => item.record.id));
    const sourcePlanningIds = new Set(loaded.filter((item) => accepted.has(item.record.type as CanonicalPlanImportType)).map((item) => item.record.id));
    if (selected.some((item) => item.record.relationships.some((id) => sourcePlanningIds.has(id) && !selectedIds.has(id)))) {
      throw new QaSkillsError("Canonical plan bundle omits a planning dependency", "ARTIFACT_BINDING");
    }
    const plans = selected.filter((item) => item.record.type === "test-plan");
    // Invariance: `selected` is derived from the source run's single read above and this function
    // registers nothing into either workspace, so both indices are valid for every plan entry and every
    // requirement below. `.filter()` → the full bucket: the `length !== 1` ambiguity decision stays here.
    const casesByIdentity = indexTestCasesByIdentity(selected);
    for (const plan of plans) {
      const entries = Array.isArray(plan.value.testCases) ? plan.value.testCases : [];
      for (const entry of entries) {
        if (!isRecord(entry) || !isRecord(entry.browserExecution)) continue;
        const execution = entry.browserExecution;
        // The plan entry owns the testcase id; its `browserExecution` owns the revision and instance.
        const matches = casesByIdentity.get({ testCaseId: entry.testCaseId, testCaseRevisionId: execution.revisionId, testCaseInstanceId: execution.instanceId });
        if (matches.length !== 1) throw new QaSkillsError("Canonical plan bundle must contain every exact executable testcase revision and instance", "ARTIFACT_BINDING");
      }
    }
    const obligationsByRequirement = indexByKey(selected.filter((item) => item.record.type === "coverage-obligation"), (item) => item.value.requirementId);
    const requiredRequirementIds = new Set(plans.flatMap((plan) => array(plan.value.testCases)).flatMap((entry) => isRecord(entry) ? array(entry.expectedResults) : []).flatMap((expected) => isRecord(expected) && typeof expected.requirementId === "string" ? [expected.requirementId] : []));
    for (const requirementId of requiredRequirementIds) if (obligationsByRequirement.get(requirementId).length === 0) throw new QaSkillsError("Canonical plan bundle omits a coverage obligation for a planned expected result", "ARTIFACT_BINDING");
    const environment = (await workspace.readRegisteredArtifacts()).find((item) => item.record.type === "environment-profile")?.value;
    if (typeof environment?.classification !== "string") throw new QaSkillsError("Import target has no valid environment", "ARTIFACT_BINDING");
    return [...selected].sort((left, right) => {
      const order = ["requirement-analysis", "test-plan", "test-case", "coverage-obligation"];
      return order.indexOf(left.record.type) - order.indexOf(right.record.type) || left.record.id.localeCompare(right.record.id);
    }).map((item) => {
      const type = item.record.type as CanonicalPlanImportType;
      const value = JSON.parse(JSON.stringify(item.value)) as Record<string, unknown>;
      let referenceFields: Record<string, string> | undefined;
      if (type === "coverage-obligation") {
        const sourceAnalysis = asString(value.requirementAnalysisArtifactId, "coverage obligation requirement analysis ID");
        referenceFields = { requirementAnalysisArtifactId: sourceAnalysis };
      }
      if (type === "test-plan") delete value.approvalDecision;
      return {
        key: item.record.id,
        type,
        value,
        relationshipKeys: item.record.relationships.filter((id) => selectedIds.has(id)),
        ...(referenceFields === undefined ? {} : { referenceFields }),
        provenance: canonicalImportProvenance(bundle.sourceRunId, { artifactId: item.record.id, sha256: item.record.sha256 }),
      };
    });
  } finally { await source.close(); }
}

/** Imports a checked canonical planning bundle in dependency order with rebuilt target relationships. */
export async function importCanonicalPlanBundle(workspace: RunWorkspace, bundle: CanonicalPlanBundleRef): Promise<ReadonlyMap<string, ArtifactRecord>> {
  return workspace.registerArtifactValueBatch(await buildCanonicalPlanImportBatch(workspace, bundle));
}

async function assertCanonicalPlanImportMapping(workspace: RunWorkspace, bundle: CanonicalPlanBundleRef, imported: readonly RegisteredWorkspaceArtifact[]): Promise<readonly string[]> {
  const batch = await buildCanonicalPlanImportBatch(workspace, bundle);
  if (imported.length !== batch.length) throw new QaSkillsError("Canonical import does not have an exact one-to-one source artifact mapping", "ARTIFACT_BINDING");
  const mapped = new Map<string, RegisteredWorkspaceArtifact>();
  // Invariance: `imported` is a parameter this function never mutates and nothing registers here, so the
  // index serves every batch item. `.filter()` → the full bucket, so the `length !== 1` duplicate-import
  // decision below is unchanged.
  const importedByProvenance = indexByKey(imported, (artifact) => artifact.record.provenance);
  for (const item of batch) {
    const matches = importedByProvenance.get(item.provenance);
    if (matches.length !== 1 || matches[0]?.record.type !== item.type) throw new QaSkillsError("Canonical import provenance does not map to the exact source artifact type", "ARTIFACT_BINDING");
    mapped.set(item.key, matches[0]);
  }
  const targetArtifacts = await workspace.readRegisteredArtifacts();
  const classification = targetArtifacts.find((artifact) => artifact.record.type === "environment-profile")?.value.classification;
  if (!["local", "test", "staging", "production"].includes(String(classification))) throw new QaSkillsError("Import target has no valid approval environment", "ARTIFACT_BINDING");
  const requirementAnalyses = batch.filter((item) => item.type === "requirement-analysis").map((item) => item.value);
  for (const item of batch) {
    const actual = mapped.get(item.key);
    if (!actual) throw new QaSkillsError("Canonical import source artifact mapping is incomplete", "ARTIFACT_BINDING");
    let expectedValue = JSON.parse(JSON.stringify(item.value)) as Record<string, unknown>;
    for (const [field, key] of Object.entries(item.referenceFields ?? {})) {
      const dependency = mapped.get(key);
      if (!dependency) throw new QaSkillsError("Canonical import reference dependency mapping is incomplete", "ARTIFACT_BINDING");
      expectedValue[field] = dependency.record.id;
    }
    if (item.type === "test-plan") {
      expectedValue = { ...expectedValue, approvalDecision: deriveTestPlanApproval({ plan: expectedValue, requirementAnalyses, environment: { classification: classification as ApprovalEnvironment["classification"] } }) };
    }
    const expectedRelationships = item.relationshipKeys.map((key) => {
      const dependency = mapped.get(key);
      if (!dependency) throw new QaSkillsError("Canonical import relationship dependency mapping is incomplete", "ARTIFACT_BINDING");
      return dependency.record.id;
    });
    const expectedChecksum = sha256Text(`${JSON.stringify(expectedValue, null, 2)}\n`);
    if (JSON.stringify(actual.value) !== JSON.stringify(expectedValue) || actual.record.sha256 !== expectedChecksum
      || JSON.stringify(actual.record.relationships) !== JSON.stringify(expectedRelationships)) {
      throw new QaSkillsError("Canonical import target value, checksum, or rebuilt dependencies do not match the exact source artifact mapping", "ARTIFACT_BINDING");
    }
  }
  return batch.map((item) => mapped.get(item.key)!.record.id);
}

function resolveRuntime<T>(items: Readonly<Record<string, T>> | undefined, id: string | undefined, label: string): T {
  if (!id || !items?.[id]) throw new QaSkillsError(`Workflow runtime ${label} is not configured`, "ARTIFACT_BINDING");
  return items[id];
}

/**
 * Environment identity is canonical; host policy may only add protection/redaction.
 * Trace retention is authorized solely by the Environment Profile's `retainTrace` permission
 * (the host runtime layer can only strengthen protection, never grant retention), and declaring
 * ANY redaction target (dom selector or region) makes the environment protected — because no
 * archive channel can prove that target was masked (ADR-0009, CONTEXT.md redaction invariant).
 *
 * The profile-side protected decision is shared with the release gate via
 * `profileDeclaresProtectedEnvironment`; here we additionally OR in the transient runtime host
 * layer (`runtime.protectedEnvironment` and any host-declared redaction targets), which the
 * persisted-artifact-only gate deliberately cannot see.
 */
export function capturePolicyForEnvironment(environment: Record<string, unknown>, host: EvidencePolicyLayers) {
  const profile = isRecord(environment.evidenceProtection) ? environment.evidenceProtection : {};
  const runtime = host.protection ?? {};
  const redaction = {
    domSelectors: [...new Set([...protectionDomSelectors(profile.domSelectors), ...protectionDomSelectors(runtime.domSelectors)])],
    regions: [...protectionRegions(profile.regions), ...protectionRegions(runtime.regions)],
  };
  return {
    protectedEnvironment: profileDeclaresProtectedEnvironment(environment) || runtime.protectedEnvironment === true || redaction.domSelectors.length > 0 || redaction.regions.length > 0,
    retainTrace: profile.retainTrace === true,
    telemetryScrubberId: runtime.telemetryScrubberId,
    redaction,
  };
}

async function executeWithRuntime(workspace: RunWorkspace, runtime: QaRuntimeRegistry, ids: NonNullable<QaWorkflowInput["runtime"]>, caseArtifactIds: readonly string[]): Promise<readonly ArtifactRecord[]> {
  const manager = resolveRuntime(runtime.browserManagers, ids.browserManagerId, "browser manager");
  const resolver = ids.secretResolverId === undefined ? undefined : resolveRuntime(runtime.secretResolvers, ids.secretResolverId, "secret resolver");
  const policy = resolveEvidencePolicy(ids.evidencePolicyId === undefined ? {} : resolveRuntime(runtime.evidencePolicies, ids.evidencePolicyId, "evidence policy"));
  const policyLayers = ids.evidencePolicyId === undefined ? {} : resolveRuntime(runtime.evidencePolicies, ids.evidencePolicyId, "evidence policy");
  const environment = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "environment-profile")?.value;
  if (!isRecord(environment)) throw new QaSkillsError("Runtime execution requires a registered environment profile", "ARTIFACT_BINDING");
  const capturePolicy = capturePolicyForEnvironment(environment, policyLayers);
  const telemetryScrubber = capturePolicy.telemetryScrubberId === undefined
    ? undefined
    : resolveRuntime(runtime.telemetryScrubbers, capturePolicy.telemetryScrubberId, "telemetry scrubber");
  const externalPermitRegistry = ids.externalPermitRegistryId === undefined
    ? undefined
    : resolveRuntime(runtime.externalPermitRegistries, ids.externalPermitRegistryId, "external permit registry");
  const executionEnvironment = {
    classification: environment.classification as "local" | "test" | "staging" | "production",
    productionReadOnly: environment.productionReadOnly === true,
  };
  const results: ArtifactRecord[] = [];
  for (const [caseIndex, testCaseArtifactId] of caseArtifactIds.entries()) {
    const artifacts = await workspace.readRegisteredArtifacts();
    const testCase = artifacts.find((artifact) => artifact.record.id === testCaseArtifactId && artifact.record.type === "test-case");
    if (!testCase) throw new QaSkillsError("Runtime execution case is not registered", "ARTIFACT_BINDING");
    const occurrence = caseArtifactIds.slice(0, caseIndex + 1).filter((id) => id === testCaseArtifactId).length - 1;
    const alreadyRegistered = artifacts.filter((artifact) => artifact.record.type === "test-result" && artifact.record.relationships.includes(testCaseArtifactId));
    if (alreadyRegistered[occurrence]) {
      const registered = alreadyRegistered[occurrence];
      const attemptId = asString(registered.value.attemptId, "registered retry attempt ID");
      // Evidence carries its attempt inside the `subject` union; an Evidence Gap still carries it flat.
      if (!artifacts.some((artifact) => artifact.record.type === "evidence"
        ? evidenceAttemptId(artifact.value) === attemptId
        : artifact.record.type === "evidence-gap" && artifact.value.attemptId === attemptId)) {
        await attachEvidence({ workspace, attemptId, callerAttemptId: attemptId, telemetry: "log", protectedEnvironment: false, testcaseId: asString(testCase.value.testCaseId, "test case ID") });
      }
      results.push(registered.record); continue;
    }
    const attemptId = `ATT-${workspace.runId}-${createEntityId()}`;
    // Only start tracing when retention is permitted up front (ADR-0009): if the Environment Profile has
    // not opted in, buffer no bytes we could never keep. A false permit starts nothing and records no gap.
    const traceActive = capturePolicy.retainTrace === true && (policy.trace === "on-failure" || policy.trace === "always" || policy.trace === "required");
    await executeTestInstance({ workspace, browser: manager.browser, attemptId, testCaseArtifactId, environment: executionEnvironment, ...(externalPermitRegistry === undefined ? {} : { externalPermitRegistry }), ...(resolver === undefined ? {} : { resolveSecret: resolver }), ...(traceActive ? { onSessionActive: async ({ session }) => { await session.context.tracing.start({ screenshots: true, snapshots: true }); } } : {}), onBeforeSessionClose: async ({ attempt, session }) => {
      const retainForStatus = policy.trace === "always" || policy.trace === "required" || (policy.trace === "on-failure" && attempt.status !== "PASSED");
      if (traceActive) {
        const unsafeTraceReason = capturePolicy.protectedEnvironment
          ? "Trace bytes are unavailable for a protected environment because deterministic archive redaction cannot be proven"
          : session.secrets.size > 0
            ? "Trace bytes are unavailable after secret resolution because deterministic archive redaction cannot be proven"
            : undefined;
        if (!retainForStatus || unsafeTraceReason !== undefined) {
          await session.context.tracing.stop();
          if (retainForStatus && unsafeTraceReason !== undefined) await recordEvidenceGap({ workspace, attemptId, reason: unsafeTraceReason, affectedClaim: "trace capture" });
        } else {
          const traceDirectory = await mkdtemp(join(tmpdir(), "qa-skills-trace-"));
          const tracePath = join(traceDirectory, "trace.zip");
          try {
            await session.context.tracing.stop({ path: tracePath });
            const bytes = await readFile(tracePath);
            const resultArtifact = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === attemptId);
            if (!resultArtifact) throw new QaSkillsError("Trace capture requires a registered attempt", "ARTIFACT_BINDING");
            const evidenceId = createEntityId();
            const capturedAt = new Date().toISOString();
            // A trace spans the whole attempt, so no single scroll position or clip describes it and none
            // is recorded. The viewport is the one geometry the session genuinely knows.
            const viewport = session.page.viewportSize() ?? { width: 1, height: 1 };
            const safeUrl = redactText(session.page.url(), [...session.secrets]);
            await workspace.registerEvidenceBundle({
              binaries: [{ filename: `${evidenceId}-trace.zip`, contents: bytes, mediaType: "application/zip", captureType: "trace" }],
              relationships: [resultArtifact.record.id],
              provenance: "runtime",
              descriptor: (binaries) => {
                const binary = binaries[0]!;
                const value = { artifactType: "evidence", schemaVersion: "2.0.0", producerVersion: "0.2.0", evidenceId, runId: workspace.runId, subject: { kind: "attempt", attemptId, testCaseId: String(testCase.value.testCaseId), testCaseRevisionId: String(testCase.value.revisionId), testCaseInstanceId: String(testCase.value.instanceId) }, kind: "trace", capturedAt, sha256: binary.sha256, relativePath: binary.relativePath, mediaType: binary.mediaType, binaryArtifactIds: [binary.id], binaryArtifacts: [{ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType }], provenance: { captureType: "trace", url: safeUrl, viewport, browser: "playwright", build: "runtime", capturedAt, testcaseId: String(testCase.value.testCaseId) } };
                const validation = validateArtifact("evidence", value);
                if (!validation.valid) throw new QaSkillsError(`Trace evidence descriptor is invalid: ${JSON.stringify(validation.errors)}`, "INVALID_ARTIFACT");
                return value;
              },
            });
          } finally {
            await rm(traceDirectory, { recursive: true, force: true });
          }
        }
      }
      const attachment = async (telemetry: "console" | "network" | "log") => {
        const evidence = await attachEvidence({ workspace, attemptId, callerAttemptId: attemptId, telemetry, protectedEnvironment: capturePolicy.protectedEnvironment, ...(telemetryScrubber === undefined ? {} : { telemetryScrubber }), testcaseId: asString(testCase.value.testCaseId, "test case ID") });
        void evidence;
      };
      if (policy.logs !== "forbidden" && policy.logs !== "off") await attachment("log");
      if (policy.console !== "forbidden" && policy.console !== "off") await attachment("console");
      if (policy.network !== "forbidden" && policy.network !== "off") await attachment("network");
      if (policy.screenshot === "always" || policy.screenshot === "required" || (policy.screenshot === "on-failure" && attempt.status !== "PASSED")) {
        if (session.secrets.size > 0) {
          await recordEvidenceGap({
            workspace,
            attemptId,
            reason: "Screenshot pixels are unavailable after secret resolution because deterministic secret-derived masking cannot be proven",
            affectedClaim: "screenshot capture",
          });
        } else {
          const evidence = await captureEvidence({ workspace, attemptId, callerAttemptId: attemptId, protectedEnvironment: capturePolicy.protectedEnvironment, redaction: capturePolicy.redaction, testcaseId: asString(testCase.value.testCaseId, "test case ID") });
          if (manager.annotateFailures === true && attempt.status !== "PASSED" && evidence.kind === "evidence") {
            const failed = attempt.steps.find((step) => step.status === "FAILED" && step.failedAssertion !== undefined && "locator" in step.failedAssertion);
            if (failed?.failedAssertion && "locator" in failed.failedAssertion) {
              const box = await resolveLocator(session.page, failed.failedAssertion.locator).boundingBox();
              const raw = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.id === evidence.descriptorArtifactId)?.value;
              const provenance = isRecord(raw?.provenance) ? raw.provenance : undefined;
              const dimensions = isRecord(provenance?.dimensions) ? provenance.dimensions : undefined;
              const scroll = isRecord(provenance?.scroll) ? provenance.scroll : undefined;
              const clip = isRecord(provenance?.clip) ? provenance.clip : undefined;
              if (box && dimensions && scroll && clip && typeof dimensions.width === "number" && typeof dimensions.height === "number" && typeof provenance?.dpr === "number" && typeof scroll.x === "number" && typeof scroll.y === "number" && typeof clip.x === "number" && typeof clip.y === "number" && typeof clip.width === "number" && typeof clip.height === "number") {
                const locator = JSON.stringify(failed.failedAssertion.locator);
                const annotations = normalizeGeometry({ image: { width: dimensions.width, height: dimensions.height, dpr: provenance.dpr, scrollX: scroll.x, scrollY: scroll.y, clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height } }, annotations: [{ id: `failure-${failed.stepId}`, box, ...(failed.error === undefined ? {} : { label: failed.error }), locator }] });
                await annotateScreenshot({ workspace, rawEvidenceDescriptorId: evidence.descriptorArtifactId, rawBinaryArtifactId: evidence.binaryArtifactId, annotations });
              }
            }
          }
        }
      }
      if (policy.video === "required") {
        await recordEvidenceGap({ workspace, attemptId, reason: "Required video capture is unsupported by the active browser manager", affectedClaim: "video capture" });
      }
    } });
    const after = await workspace.readRegisteredArtifacts();
    const result = after.filter((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === attemptId);
    if (result.length !== 1) {
      throw new QaSkillsError("Runtime execution must register one immutable result per exact testcase instance", "ARTIFACT_BINDING");
    }
    results.push(result[0]!.record);
  }
  return results;
}

type RetestScenario = Readonly<{ sourceAttemptArtifactId: string; sourceTestCaseArtifactId: string; testCaseId: string; revisionId: string; instanceId: string; parameters: Readonly<Record<string, unknown>> }>;
type RetestSource = Readonly<{ bugId: string; scenarios: readonly RetestScenario[] }>;

function scenarioIdForRegisteredAttempt(artifacts: readonly RegisteredWorkspaceArtifact[], attempt: RegisteredWorkspaceArtifact): string {
  const testCase = artifacts.find((artifact) => artifact.record.type === "test-case" && attempt.record.relationships.includes(artifact.record.id));
  if (!testCase) throw new QaSkillsError("Retest attempt lacks its exact testcase artifact binding", "ARTIFACT_BINDING");
  if (testCase.value.testCaseId !== attempt.value.testCaseId || testCase.value.revisionId !== attempt.value.testCaseRevisionId || testCase.value.instanceId !== attempt.value.testCaseInstanceId) throw new QaSkillsError("Retest attempt testcase identity binding is invalid", "ARTIFACT_BINDING");
  return sourceScenarioId({ testCaseId: asString(attempt.value.testCaseId, "retest testcase ID"), revisionId: asString(attempt.value.testCaseRevisionId, "retest testcase revision ID"), instanceId: asString(attempt.value.testCaseInstanceId, "retest testcase instance ID"), parameters: isRecord(testCase.value.parameters) ? testCase.value.parameters : {} });
}

async function sourceBugFromReference(workspace: RunWorkspace, reference: RegisteredArtifactRef): Promise<RetestSource> {
  if (!workspace.linkedRunId) throw new QaSkillsError("Retest requires a linked immutable source run", "ARTIFACT_BINDING");
  const source = await RunWorkspace.open(workspace.root, workspace.linkedRunId);
  try {
    const sourceRecord = await source.readArtifactRecord(reference.artifactId);
    if (sourceRecord.type !== "bug-report" || sourceRecord.sha256 !== reference.sha256) throw new QaSkillsError("Retest source bug reference checksum is invalid", "ARTIFACT_BINDING");
    const artifacts = await source.readRegisteredArtifacts();
    const bug = artifacts.find((artifact) => artifact.record.id === reference.artifactId && artifact.record.type === "bug-report");
    if (!bug) throw new QaSkillsError("Retest source bug is not registered", "ARTIFACT_BINDING");
    const provenance = isRecord(bug.value.provenance) ? bug.value.provenance : {};
    const sourceAttemptIds = Array.isArray(provenance.sourceAttemptIds) && provenance.sourceAttemptIds.every((id) => typeof id === "string") ? provenance.sourceAttemptIds : [asString(bug.value.attemptId, "source bug attempt ID")];
    if (sourceAttemptIds.length === 0 || new Set(sourceAttemptIds).size !== sourceAttemptIds.length) throw new QaSkillsError("Selected bug revision has invalid exact reproduction references", "ARTIFACT_BINDING");
    // Invariance: `artifacts` is the single read of the SOURCE run above, which this function only reads
    // and closes in its `finally` — nothing is registered into it, so both indices serve every scenario.
    // The relationship walk itself stays a linear `.find()`: it decides WHICH declared id wins, and only
    // the existence probe inside it is indexed.
    const resultsByAttempt = indexResultsByAttempt(artifacts);
    const testCasesById = indexByArtifactId(artifacts.filter((candidate) => candidate.record.type === "test-case"));
    const scenarios = sourceAttemptIds.map((attemptId) => {
      const attempt = resultsByAttempt.get(attemptId)[0];
      if (!attempt || attempt.value.failureClassification !== "PRODUCT_DEFECT") throw new QaSkillsError("Selected bug revision references an invalid product reproduction", "ARTIFACT_BINDING");
      const caseId = attempt.record.relationships.find((id) => testCasesById.get(id).length > 0);
      const testCase = caseId === undefined ? undefined : testCasesById.get(caseId)[0];
      if (!testCase || testCase.value.testCaseId !== attempt.value.testCaseId || testCase.value.revisionId !== attempt.value.testCaseRevisionId || testCase.value.instanceId !== attempt.value.testCaseInstanceId) throw new QaSkillsError("Source attempt is not bound to its exact canonical testcase instance", "ARTIFACT_BINDING");
      return { sourceAttemptArtifactId: attempt.record.id, sourceTestCaseArtifactId: testCase.record.id, testCaseId: asString(attempt.value.testCaseId, "source testcase ID"), revisionId: asString(attempt.value.testCaseRevisionId, "source testcase revision ID"), instanceId: asString(attempt.value.testCaseInstanceId, "source testcase instance ID"), parameters: isRecord(testCase.value.parameters) ? testCase.value.parameters : {} };
    });
    return { bugId: asString(bug.value.bugId, "source bug ID"), scenarios };
  } finally { await source.close(); }
}

async function registerRuntimeRetestResult(workspace: RunWorkspace, reference: RegisteredArtifactRef, source: RetestSource, reproductionAttemptIds: readonly string[], regressionAttemptIds: readonly string[]): Promise<ArtifactRecord> {
  const artifacts = await workspace.readRegisteredArtifacts();
  // Invariance: `artifacts` is read here; the only registration in this function is the `retest-result`
  // returned at the end, after every lookup below has run.
  const resultsByAttempt = indexResultsByAttempt(artifacts);
  const reproduction = reproductionAttemptIds.map((attemptId) => resultsByAttempt.get(attemptId)[0]);
  const expectedOccurrences = source.scenarios.map(sourceScenarioId).sort();
  const actualOccurrences = reproduction.map((attempt) => attempt === undefined ? "" : scenarioIdForRegisteredAttempt(artifacts, attempt)).sort();
  if (reproduction.length === 0 || reproduction.some((attempt) => !attempt) || JSON.stringify(actualOccurrences) !== JSON.stringify(expectedOccurrences)) throw new QaSkillsError("Retest reproduction did not execute every exact immutable source scenario occurrence", "ARTIFACT_BINDING");
  const regression = regressionAttemptIds.map((attemptId) => resultsByAttempt.get(attemptId)[0]).filter((attempt): attempt is NonNullable<typeof attempt> => attempt !== undefined);
  const regressionOutcome = deriveRegressionOutcome(regression.map((attempt) => asString(attempt.value.status, "regression execution status")));
  const reproductionScenarios = reproduction.map((attempt, index) => ({ scenarioId: attempt === undefined ? "" : scenarioIdForRegisteredAttempt(artifacts, attempt), sourceAttemptArtifactId: source.scenarios[index]!.sourceAttemptArtifactId, sourceTestCaseArtifactId: source.scenarios[index]!.sourceTestCaseArtifactId, attemptId: asString(attempt?.value.attemptId, "reproduction attempt ID"), status: asString(attempt?.value.status, "reproduction execution status") }));
  const verdict = deriveRetestVerdict({ originalBugId: source.bugId, reproductionStatuses: reproductionScenarios.map((scenario) => scenario.status), scenarioIds: reproductionScenarios.map((scenario) => scenario.scenarioId), regressionOutcome });
  return workspace.registerArtifactValue({ type: "retest-result", value: { artifactType: "retest-result", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: workspace.runId, sourceRunId: workspace.linkedRunId, sourceBugArtifactId: reference.artifactId, sourceBugArtifactSha256: reference.sha256, bugId: source.bugId, reproductionAttemptIds: [...reproductionAttemptIds], reproductionScenarios, regressionAttemptIds: [...regressionAttemptIds], verdict: verdict.verdict, regressionOutcome }, relationships: [...reproduction, ...regression].map((attempt) => attempt?.record.id).filter((id): id is string => id !== undefined), provenance: "runtime" });
}

async function assertApprovedCanonicalRevisions(workspace: RunWorkspace, ids: readonly string[] | undefined): Promise<void> {
  const artifacts = await workspace.readRegisteredArtifacts();
  const testCases = artifacts.filter((artifact) => artifact.record.type === "test-case");
  // Invariance: `artifacts` is read here and this assertion registers nothing.
  const byId = indexByArtifactId(artifacts);
  const requested = ids === undefined ? testCases : ids.map((id) => byId.get(id)[0]).filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== undefined);
  if (ids !== undefined && requested.length !== ids.length) throw new QaSkillsError("Execution requires caller-identified registered canonical revisions", "ARTIFACT_BINDING");
  if (requested.length === 0) throw new QaSkillsError("Execution requires at least one approved canonical test case revision", "ARTIFACT_BINDING");
  for (const testCase of requested) {
    if (testCase.record.type !== "test-case") throw new QaSkillsError("Execution accepts only registered test case revisions", "ARTIFACT_BINDING");
    const plans = artifacts.filter((plan) => plan.record.type === "test-plan" && testCase.record.relationships.includes(plan.record.id));
    const approved = plans.some((plan) => isRecord(plan.value.approvalDecision) && plan.value.approvalDecision.approved === true
      && Array.isArray(plan.value.testCases) && plan.value.testCases.some((entry) => isRecord(entry) && entry.testCaseId === testCase.value.testCaseId));
    if (!approved) throw new QaSkillsError("Execution requires approved canonical test case revisions", "ARTIFACT_BINDING");
  }
}

async function sourceBug(workspace: RunWorkspace, sourceRunId: string, sourceBugArtifactId: string): Promise<{ bugId: string; attemptId: string; testCaseId: string; revisionId: string; instanceId: string; record: ArtifactRecord }> {
  const source = await RunWorkspace.open(workspace.root, sourceRunId);
  try {
    const artifacts = await source.readRegisteredArtifacts();
    const bug = artifacts.find((artifact) => artifact.record.id === sourceBugArtifactId && artifact.record.type === "bug-report");
    if (!bug || typeof bug.value.bugId !== "string" || typeof bug.value.attemptId !== "string") throw new QaSkillsError("Retest requires an explicit registered source product bug", "ARTIFACT_BINDING");
    const original = artifacts.find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === bug.value.attemptId);
    if (!original || typeof original.value.testCaseId !== "string" || typeof original.value.testCaseRevisionId !== "string" || typeof original.value.testCaseInstanceId !== "string") throw new QaSkillsError("Retest source bug lacks its immutable original reproduction", "ARTIFACT_BINDING");
    return { bugId: bug.value.bugId, attemptId: bug.value.attemptId, testCaseId: original.value.testCaseId, revisionId: original.value.testCaseRevisionId, instanceId: original.value.testCaseInstanceId, record: await source.readArtifactRecord(sourceBugArtifactId) };
  } finally { await source.close(); }
}

async function registerCharter(workspace: RunWorkspace, charter: ExplorationCharter): Promise<ArtifactRecord> {
  const valid = assertExplorationCharter(charter);
  const environment = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "environment-profile");
  if (!environment) throw new QaSkillsError("Exploration charter requires the registered environment", "ARTIFACT_BINDING");
  return workspace.registerArtifactValue({ type: "exploration-charter", value: {
    artifactType: "exploration-charter", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: workspace.runId, ...valid,
  }, relationships: [environment.record.id], provenance: "runtime" });
}

async function registerSelection(workspace: RunWorkspace, selection: RegressionSelection, changeScope: ArtifactRecord): Promise<ArtifactRecord> {
  const artifacts = await workspace.readRegisteredArtifacts();
  // Invariance: `artifacts` is read here; the only registration in this function is the
  // `regression-selection` returned at the end, after every decision has been resolved.
  const casesByIdentity = indexTestCasesByIdentity(artifacts);
  const decisions = [...selection.selected, ...selection.excluded];
  const relationships = decisions.flatMap((decision) => casesByIdentity.get({ testCaseId: decision.testCaseId, testCaseRevisionId: decision.revisionId, testCaseInstanceId: decision.instanceId }));
  if (relationships.length !== decisions.length) throw new QaSkillsError("Regression selection requires every decision to bind one registered canonical test case revision", "ARTIFACT_BINDING");
  return workspace.registerArtifactValue({ type: "regression-selection", value: {
    artifactType: "regression-selection", schemaVersion: "1.0.0", producerVersion: "0.1.0", selectionId: `REG-${workspace.runId}`, runId: workspace.runId,
    changeScopeArtifactId: changeScope.id, changeScopeSha256: changeScope.sha256, decisionChecksum: sha256Text(JSON.stringify(selection)), ...selection,
  }, relationships: [changeScope.id, ...relationships.map((artifact) => artifact.record.id)], provenance: "runtime" });
}

/** Indexes the pool it is HANDED, per call: each caller passes a different read, and one of them
 *  (`select-regression`) passes a read taken after the run has registered further artifacts. */
function selectedCaseArtifactIds(selection: RegressionSelection, artifacts: readonly RegisteredWorkspaceArtifact[]): string[] {
  const casesByIdentity = indexTestCasesByIdentity(artifacts);
  return selection.selected.flatMap((decision) => casesByIdentity.get({ testCaseId: decision.testCaseId, testCaseRevisionId: decision.revisionId, testCaseInstanceId: decision.instanceId }).map((artifact) => artifact.record.id));
}

/** Copies immutable testcase revision snapshots from a terminal source run into a fresh regression workspace. */
async function importRegressionCases(workspace: RunWorkspace, sourceRunId: string): Promise<void> {
  const source = await RunWorkspace.open(workspace.root, sourceRunId);
  try {
    const cases = (await source.readRegisteredArtifacts()).filter((artifact) => artifact.record.type === "test-case");
    if (cases.length === 0) throw new QaSkillsError("Regression source run has no canonical testcase revisions", "ARTIFACT_BINDING");
    for (const testCase of cases) await workspace.registerArtifactValue({ type: "test-case", value: testCase.value, relationships: [], provenance: `runtime-import:${sourceRunId}:${testCase.record.id}` });
  } finally { await source.close(); }
}

async function exactRetestReproduction(workspace: RunWorkspace, input: NonNullable<WorkflowInput["retest"]>): Promise<{ sourceRunId: string; source: Awaited<ReturnType<typeof sourceBug>>; statuses: readonly string[] }> {
  if (!workspace.runId || !input.sourceBugArtifactId) throw new QaSkillsError("Retest requires a source bug artifact", "ARTIFACT_BINDING");
  // The linked source is immutable metadata, not a caller-supplied report field.
  const metadataSourceRunId = workspace.linkedRunId;
  if (!metadataSourceRunId) throw new QaSkillsError("Retest requires a linked immutable source run", "ARTIFACT_BINDING");
  const source = await sourceBug(workspace, metadataSourceRunId, input.sourceBugArtifactId);
  if (input.reproductionAttemptIds.length === 0 || new Set(input.reproductionAttemptIds).size !== input.reproductionAttemptIds.length) throw new QaSkillsError("Retest requires distinct exact reproduction attempts", "ARTIFACT_BINDING");
  const registered = await workspace.readRegisteredArtifacts();
  // Invariance: `registered` is read here and this function registers nothing.
  const resultsByAttempt = indexResultsByAttempt(registered);
  const reproduction = input.reproductionAttemptIds.map((attemptId) => resultsByAttempt.get(attemptId)[0]);
  if (reproduction.some((attempt) => !attempt) || reproduction.some((attempt) => attempt?.value.testCaseId !== source.testCaseId || attempt?.value.testCaseRevisionId !== source.revisionId || attempt?.value.testCaseInstanceId !== source.instanceId)) {
    throw new QaSkillsError("Retest must reproduce the original bug with its exact canonical testcase revision before regression", "ARTIFACT_BINDING");
  }
  return { sourceRunId: metadataSourceRunId, source, statuses: reproduction.map((attempt) => String(attempt?.value.status)) };
}

async function registerRetestResult(workspace: RunWorkspace, input: NonNullable<WorkflowInput["retest"]>): Promise<ArtifactRecord> {
  const reproduction = await exactRetestReproduction(workspace, input);
  const verdict = deriveRetestVerdict({ originalBugId: reproduction.source.bugId, reproductionStatuses: reproduction.statuses, ...(input.regressionOutcome === undefined ? {} : { regressionOutcome: input.regressionOutcome }) });
  return workspace.registerArtifactValue({ type: "retest-result", value: {
    artifactType: "retest-result", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: workspace.runId, sourceRunId: reproduction.sourceRunId,
    sourceBugArtifactId: input.sourceBugArtifactId, sourceBugArtifactSha256: reproduction.source.record.sha256, bugId: verdict.bugId, reproductionAttemptIds: [...input.reproductionAttemptIds], reproductionScenarios: input.reproductionAttemptIds.map((attemptId, index) => ({ scenarioId: sourceScenarioId({ testCaseId: reproduction.source.testCaseId, revisionId: reproduction.source.revisionId, instanceId: reproduction.source.instanceId }), attemptId, status: reproduction.statuses[index] })), regressionAttemptIds: [], verdict: verdict.verdict,
    regressionOutcome: verdict.regressionOutcome ?? "NOT_RUN",
  }, relationships: (await workspace.readRegisteredArtifacts()).filter((artifact) => artifact.record.type === "test-result" && input.reproductionAttemptIds.includes(String(artifact.value.attemptId))).map((artifact) => artifact.record.id), provenance: "runtime" });
}

/** Executes only typed, dependency-declared runtime operations. It never invokes shells or Skill Adapters. */
type WorkflowRegistry = Readonly<Partial<Record<WorkflowOperationName, WorkflowOperation>>>;

/**
 * Unsafe test seam. It is deliberately not part of the QA Tester adapter:
 * production callers must use createQaTester and its closed runtime registry.
 */
export function createUnsafeWorkflowRunnerForTests(registry: WorkflowRegistry): (input: WorkflowInput) => Promise<WorkflowResult> {
  return (input) => runWorkflowWithRegistry(input, registry);
}

/**
 * Constructs the production QA Tester around a closed, typed host registry.
 * This is deliberately separate from the unsafe test callback factory, whose
 * registry is a test seam and is not exported through a Skill Adapter.
 */
export function createQaTester(runtime: QaRuntimeRegistry): (input: QaWorkflowInput) => Promise<WorkflowResult> {
  return (input) => runQaTesterWithAdapters(runtime, input, closedOperationAdapters);
}

/** Explicit test seam for observing the closed production loop without adding
 * callbacks to the public Skill Adapter. */
export function createQaTesterWithTraceForTests(runtime: QaRuntimeRegistry, trace: (event: `${WorkflowOperationName}:${"adapter" | "postcondition"}`) => void): (input: QaWorkflowInput) => Promise<WorkflowResult> {
  const traced = Object.fromEntries(Object.entries(closedOperationAdapters).map(([key, adapter]) => [key, {
    ...adapter,
    execute: async (state: WorkflowExecutionState) => { trace(`${key as WorkflowOperationName}:adapter`); return adapter.execute(state); },
    assertPostcondition: async (workspace: RunWorkspace, output: never) => { trace(`${key as WorkflowOperationName}:postcondition`); await adapter.assertPostcondition(workspace, output); },
  }])) as typeof closedOperationAdapters;
  return (input) => runQaTesterWithAdapters(runtime, input, traced);
}

/** Reads the single persisted release-gate artifact's recommendation; never recomputes the gate. */
function releaseRecommendationFromArtifacts(artifacts: readonly RegisteredWorkspaceArtifact[]): ReleaseRecommendation | undefined {
  const gates = artifacts.filter((artifact) => artifact.record.type === "release-gate");
  if (gates.length !== 1) return undefined;
  const recommendation = gates[0]!.value.recommendation;
  if (recommendation === "READY" || recommendation === "READY_WITH_RISKS" || recommendation === "NOT_READY") return recommendation;
  return undefined;
}

/** Finalizes once and derives the returned outcome from the same facts persisted in run metadata. */
export async function finalizeWorkflowOutcome(workspace: RunWorkspace, mode: PublicWorkflowMode): Promise<{ outcome: Extract<WorkflowTerminalStatus, "COMPLETED" | "COMPLETED_WITH_FAILURES">; validation: WorkspaceValidation; releaseRecommendation?: ReleaseRecommendation }> {
  const artifacts = await workspace.readRegisteredArtifacts();
  const hasExecutionFailures = artifacts.some((artifact) => artifact.record.type === "test-result" && artifact.value.status !== "PASSED");
  const terminal = evaluatePublicTerminalProfile(mode, artifacts.map((artifact) => artifact.record.type));
  const structural = await workspace.finalize(mode, hasExecutionFailures || !terminal.valid ? "COMPLETED_WITH_FAILURES" : undefined);
  const validation = { valid: structural.valid && terminal.valid, diagnostics: [...structural.diagnostics, ...terminal.diagnostics] };
  const releaseRecommendation = releaseRecommendationFromArtifacts(artifacts);
  return { outcome: hasExecutionFailures || !validation.valid ? "COMPLETED_WITH_FAILURES" : "COMPLETED", validation, ...(releaseRecommendation === undefined ? {} : { releaseRecommendation }) };
}

async function outputRecords(workspace: RunWorkspace, output: WorkflowOutput): Promise<readonly ArtifactRecord[]> {
  if (Array.isArray(output) && output.every(artifactRecord)) return output;
  if (artifactRecord(output)) return [output];
  if (!Array.isArray(output) || !output.every((item) => typeof item === "string")) return [];
  const artifacts = await workspace.readRegisteredArtifacts();
  return artifacts.filter((artifact) => output.includes(artifact.record.id) || output.includes(String(artifact.value.evidenceId)) || output.includes(String(artifact.value.evidenceGapId))).map((artifact) => artifact.record);
}

function outputFromRecords<Name extends WorkflowOperationName>(operation: Name, records: readonly ArtifactRecord[]): WorkflowOperationOutputMap[Name] {
  if (operation === "prepare-test-data" || operation === "register-exploration-charter" || operation === "select-regression" || operation === "derive-retest-verdict") {
    if (records.length !== 1) throw new QaSkillsError(`Workflow checkpoint output for ${operation} is not canonical`, "ARTIFACT_BINDING");
    return records[0] as WorkflowOperationOutputMap[Name];
  }
  return records as WorkflowOperationOutputMap[Name];
}

async function validateCheckpointRefs(workspace: RunWorkspace, refs: readonly RegisteredArtifactRef[]): Promise<readonly RegisteredWorkspaceArtifact[]> {
  const artifacts = await workspace.readRegisteredArtifacts();
  // Invariance: `artifacts` is read here and this function registers nothing. The checksum comparison
  // stays at the call site, over the bucket holding exactly the artifacts registered under that id.
  const byId = indexByArtifactId(artifacts);
  const resolved = refs.map((reference) => byId.get(reference.artifactId).find((artifact) => artifact.record.sha256 === reference.sha256));
  if (resolved.some((artifact) => artifact === undefined)) throw new QaSkillsError("Workflow checkpoint state is not immutable", "ARTIFACT_BINDING");
  return resolved.filter((artifact): artifact is RegisteredWorkspaceArtifact => artifact !== undefined);
}

async function hydrateCheckpointState(state: WorkflowExecutionState): Promise<void> {
  const snapshot = state.checkpoint.state;
  const imported = await validateCheckpointRefs(state.workspace, snapshot.importedArtifacts);
  const execution = await validateCheckpointRefs(state.workspace, snapshot.executionCases);
  const reproduction = await validateCheckpointRefs(state.workspace, snapshot.reproductionAttempts);
  const regression = await validateCheckpointRefs(state.workspace, snapshot.regressionAttempts);
  const findings = await validateCheckpointRefs(state.workspace, snapshot.exploratoryFindings);
  if (execution.some((artifact) => artifact.record.type !== "test-case") || reproduction.some((artifact) => artifact.record.type !== "test-result") || regression.some((artifact) => artifact.record.type !== "test-result") || findings.some((artifact) => artifact.record.type !== "exploratory-finding")) throw new QaSkillsError("Workflow checkpoint state type binding is invalid", "ARTIFACT_BINDING");
  state.importedArtifactIds = imported.map((artifact) => artifact.record.id);
  state.executionCaseIds = execution.map((artifact) => artifact.record.id);
  state.reproductionAttemptIds = reproduction.map((artifact) => asString(artifact.value.attemptId, "reproduction attempt ID"));
  state.regressionAttemptIds = regression.map((artifact) => asString(artifact.value.attemptId, "regression attempt ID"));
  state.exploratoryFindingIds = findings.map((artifact) => artifact.record.id);
  if (snapshot.selection) {
    const [selection] = await validateCheckpointRefs(state.workspace, [snapshot.selection]);
    if (selection?.record.type !== "regression-selection") throw new QaSkillsError("Workflow checkpoint regression selection is invalid", "ARTIFACT_BINDING");
    state.selection = selection.value as RegressionSelection;
    const outputRefs = state.checkpoint.operationOutputs["select-regression"] ?? [];
    if (outputRefs.length !== 1 || outputRefs[0]?.artifactId !== selection.record.id || outputRefs[0]?.sha256 !== selection.record.sha256) {
      throw new QaSkillsError("Workflow checkpoint selection output is not the canonical selected-case authority", "ARTIFACT_BINDING");
    }
    const all = await state.workspace.readRegisteredArtifacts();
    const selected = selectedCaseArtifactIds(state.selection, all);
    // Invariance: `all` is read here and hydration registers nothing. The decision-INDEPENDENT half of
    // the removed predicate (test-case declared by this selection) is hoisted into the indexed pool and
    // stays a linear membership filter; only the identity triple is indexed, and the `length !== 1`
    // ambiguity decision stays below.
    const declaredCasesByIdentity = indexByTestCaseIdentity(all.filter((artifact) => artifact.record.type === "test-case" && selection.record.relationships.includes(artifact.record.id)), testCaseIdentityOf);
    const selectedRelationships = state.selection.selected.map((decision) => declaredCasesByIdentity.get({ testCaseId: decision.testCaseId, testCaseRevisionId: decision.revisionId, testCaseInstanceId: decision.instanceId }));
    if (selected.length !== state.selection.selected.length || selectedRelationships.some((matches) => matches.length !== 1)) throw new QaSkillsError("Workflow checkpoint regression selection has ambiguous selected testcase bindings", "ARTIFACT_BINDING");
    state.executionCaseIds = selected;
  } else {
    const ingested = state.checkpoint.operationOutputs["ingest-testcases"] ?? [];
    if (ingested.length > 0) {
      const cases = await validateCheckpointRefs(state.workspace, ingested);
      if (cases.some((artifact) => artifact.record.type !== "test-case")) throw new QaSkillsError("Workflow checkpoint testcase output is invalid", "ARTIFACT_BINDING");
      state.executionCaseIds = cases.map((artifact) => artifact.record.id);
    }
  }
  if (snapshot.charter) {
    const [charter] = await validateCheckpointRefs(state.workspace, [snapshot.charter]);
    if (charter?.record.type !== "exploration-charter") throw new QaSkillsError("Workflow checkpoint charter is invalid", "ARTIFACT_BINDING");
    state.charterArtifactId = charter.record.id;
  }
  if (snapshot.retestSource) state.retestSource = snapshot.retestSource;
}

async function hydrateCheckpointOutput(state: WorkflowExecutionState, operation: WorkflowOperationName): Promise<void> {
  const references = state.checkpoint.operationOutputs[operation] ?? [];
  const records = (await validateCheckpointRefs(state.workspace, references)).map((artifact) => artifact.record);
  state.outputs[operation] = outputFromRecords(operation, records) as never;
}

async function ensureCanonicalBundle(state: WorkflowExecutionState): Promise<void> {
  const needsBundle = ["plan", "execute", "full", "regression", "retest"].includes(state.input.mode);
  if (!needsBundle) return;
  if (!state.input.bundle) throw new QaSkillsError("Workflow requires a checksum-bound canonical plan bundle", "ARTIFACT_BINDING");
  const all = await state.workspace.readRegisteredArtifacts();
  const importPrefix = `runtime-import:${state.input.bundle.sourceRunId}:`;
  const expected = new Set(state.input.bundle.artifacts.map((artifact) => canonicalImportProvenance(state.input.bundle!.sourceRunId, artifact)));
  const provenanceImports = all.filter((artifact) => artifact.record.provenance.startsWith(importPrefix));
  // Indexes exactly the array the removed `.filter()` scanned, so it is precisely as fresh as that array
  // was. The only registration in this function — `importCanonicalPlanBundle` — is in the sibling branch
  // below, which is mutually exclusive with the `else if` that consults this index.
  const provenanceImportsByProvenance = indexByKey(provenanceImports, (artifact) => artifact.record.provenance);
  if (state.importedArtifactIds.length === 0) {
    if (provenanceImports.length === 0) {
      const imported = await importCanonicalPlanBundle(state.workspace, state.input.bundle);
      state.importedArtifactIds = [...imported.values()].map((artifact) => artifact.id);
    } else if (provenanceImports.length === expected.size
      && provenanceImports.every((artifact) => expected.has(artifact.record.provenance))
      && [...expected].every((provenance) => provenanceImportsByProvenance.get(provenance).length === 1)) {
      // The batch commit may win the crash race against its checkpoint. Rebuild
      // every exact source-to-target mapping before adopting those target IDs.
      state.importedArtifactIds = [...await assertCanonicalPlanImportMapping(state.workspace, state.input.bundle, provenanceImports)];
    } else {
      throw new QaSkillsError("Already-imported canonical bundle mapping is partial, duplicated, or does not match the exact source checksum set", "ARTIFACT_BINDING");
    }
  } else {
    const imported = all.filter((artifact) => state.importedArtifactIds.includes(artifact.record.id));
    // Nothing has been registered on this branch — the import above belongs to the sibling branch — so
    // the index describes the same pool as the `.some()` it replaces.
    const importedByProvenance = indexByKey(imported, (artifact) => artifact.record.provenance);
    const checkpointImportIds = new Set(state.importedArtifactIds);
    const workspaceImportIds = new Set(provenanceImports.map((artifact) => artifact.record.id));
    if (checkpointImportIds.size !== state.importedArtifactIds.length || workspaceImportIds.size !== provenanceImports.length
      || checkpointImportIds.size !== workspaceImportIds.size
      || [...checkpointImportIds].some((id) => !workspaceImportIds.has(id))
      || [...workspaceImportIds].some((id) => !checkpointImportIds.has(id))) {
      throw new QaSkillsError("Workflow checkpoint imported artifact IDs do not exactly match the complete workspace provenance import mapping", "ARTIFACT_BINDING");
    }
    if (imported.length !== expected.size || imported.some((artifact) => !expected.has(artifact.record.provenance))
      || [...expected].some((provenance) => importedByProvenance.get(provenance).length === 0)) {
      throw new QaSkillsError("Workflow checkpoint canonical bundle mapping is incomplete or does not match the exact source artifacts", "ARTIFACT_BINDING");
    }
    await assertCanonicalPlanImportMapping(state.workspace, state.input.bundle, imported);
  }
  if (state.executionCaseIds.length === 0) state.executionCaseIds = (await state.workspace.readRegisteredArtifacts()).filter((artifact) => state.importedArtifactIds.includes(artifact.record.id) && artifact.record.type === "test-case").map((artifact) => artifact.record.id);
}

async function runQaTesterWithAdapters(runtime: QaRuntimeRegistry, input: QaWorkflowInput, adapters: typeof closedOperationAdapters): Promise<WorkflowResult> {
  const workspace = input.resumeRunId === undefined
    ? await RunWorkspace.create({ root: input.root, mode: input.mode, environmentProfile: input.environmentProfile, ...(input.linkedRunId === undefined ? {} : { linkedRunId: input.linkedRunId }) })
    : await RunWorkspace.open(input.root, input.resumeRunId);
  const order = operationsForMode(input.mode);
  const outputs: CorrelatedWorkflowOutputs = {};
  try {
    if (workspace.mode !== input.mode || workspace.linkedRunId !== input.linkedRunId) throw new QaSkillsError("Resume workspace does not match the requested immutable workflow identity", "ARTIFACT_BINDING");
    const checkpoint = await checkpointWorkflow(workspace, input);
    const state: WorkflowExecutionState = { workspace, input, runtime, outputs, checkpoint, executionCaseIds: [], importedArtifactIds: [], reproductionAttemptIds: [], regressionAttemptIds: [], exploratoryFindingIds: [] };
    await hydrateCheckpointState(state);
    if (input.retest && checkpoint.completedOperations.includes("reproduce-bug")) state.retestSource = await sourceBugFromReference(workspace, input.retest.sourceBug);
    const missing = missingRuntimeLabel(runtime, input);
    if (missing !== undefined) return { runId: workspace.runId, mode: input.mode, outcome: "AWAITING_RUNTIME", operationOrder: order, outputs, validation: await workspace.validate(input.mode) };
    if (input.mode === "retest") {
      if (!input.retest) throw new QaSkillsError("Retest requires a checksum-bound source bug reference", "ARTIFACT_BINDING");
      resolveRuntime(runtime.changeScopeSources, input.runtime?.changeScopeSourceId, "change-scope source");
    }
    await ensureCanonicalBundle(state);
    // The only production operation dispatch: one complete typed map,
    // exactly the metadata order for the selected public mode.
    for (const name of order) {
      const adapter = adapters[name];
      if (state.checkpoint.completedOperations.includes(name)) {
        await hydrateCheckpointOutput(state, name);
        await adapter.assertPostcondition(workspace, state.outputs[name] as never);
        continue;
      }
      const output = await adapter.execute(state);
      await adapter.assertPostcondition(workspace, output as never);
      state.outputs[name] = output as never;
      state.checkpoint = await advanceCheckpoint(workspace, input, state.checkpoint, name, await outputRecords(workspace, output), state);
    }
    const { outcome, validation, releaseRecommendation } = await finalizeWorkflowOutcome(workspace, input.mode);
    return { runId: workspace.runId, mode: input.mode, outcome, operationOrder: order, outputs, validation, ...(releaseRecommendation === undefined ? {} : { releaseRecommendation }) };
  } finally { await workspace.close(); }
}

/** Operation bodies may discriminate mode, but only this closed adapter map invokes them. */
async function runClosedOperation<Name extends WorkflowOperationName>(state: WorkflowExecutionState, name: Name): Promise<WorkflowOperationOutputMap[Name]> {
  const { workspace, input, runtime } = state;
  const artifacts = async () => workspace.readRegisteredArtifacts();
  const cases = async () => (await artifacts()).filter((artifact) => artifact.record.type === "test-case");
  if (name === "ingest-requirement-analysis") return (await artifacts()).filter((artifact) => artifact.record.type === "requirement-analysis").map((artifact) => artifact.record) as unknown as WorkflowOperationOutputMap[Name];
  if (name === "ingest-testcases") return (await cases()).map((artifact) => artifact.record) as unknown as WorkflowOperationOutputMap[Name];
  if (name === "ingest-coverage-obligation") {
    return (await artifacts()).filter((artifact) => artifact.record.type === "coverage-obligation").map((artifact) => artifact.record) as unknown as WorkflowOperationOutputMap[Name];
  }
  if (name === "prepare-test-data") {
    const hooks = resolveRuntime(runtime.testDataRegistries, input.runtime?.testDataRegistryId, "test-data registry");
    await prepareTestData({ workspace, hooks, hookIds: input.runtime?.testDataHookIds ?? [] });
    const manifest = (await artifacts()).find((artifact) => artifact.record.type === "test-data-manifest");
    if (!manifest) throw new QaSkillsError("Test-data operation did not register its manifest", "ARTIFACT_BINDING");
    return manifest.record as WorkflowOperationOutputMap[Name];
  }
  if (name === "register-exploration-charter") {
    if (!input.charter) throw new QaSkillsError("Exploratory workflow requires exactly one charter", "INVALID_ARTIFACT");
    const charter = await registerCharter(workspace, input.charter);
    state.charterArtifactId = charter.id;
    return charter as WorkflowOperationOutputMap[Name];
  }
  if (name === "reproduce-bug") {
    if (!input.retest) throw new QaSkillsError("Retest requires a checksum-bound source bug reference", "ARTIFACT_BINDING");
    const source = await sourceBugFromReference(workspace, input.retest.sourceBug);
    state.retestSource = source;
    const available = await cases();
    // Invariance: `available` comes from the read on the line above and is consulted only on the next
    // line — BEFORE `executeWithRuntime` registers this run's reproduction results. Every scan after
    // that call re-reads the workspace and is deliberately left unindexed.
    const availableByIdentity = indexTestCasesByIdentity(available);
    const exact = source.scenarios.map((scenario) => availableByIdentity.get({ testCaseId: scenario.testCaseId, testCaseRevisionId: scenario.revisionId, testCaseInstanceId: scenario.instanceId })[0]);
    if (exact.some((artifact) => artifact === undefined)) throw new QaSkillsError("Retest bundle must import every exact original testcase revision and instance", "ARTIFACT_BINDING");
    // Keep duplicate source occurrences: each one is a real reproduction
    // attempt, while sourceScenarioId remains the canonical scenario identity.
    await executeWithRuntime(workspace, runtime, input.runtime ?? {}, exact.map((artifact) => artifact!.record.id));
    const required = source.scenarios.map(sourceScenarioId).sort();
    const all = await artifacts();
    const results = all.filter((artifact) => artifact.record.type === "test-result" && required.includes(scenarioIdForRegisteredAttempt(all, artifact))).map((artifact) => asString(artifact.value.attemptId, "reproduction attempt ID"));
    const actual = all.filter((artifact) => artifact.record.type === "test-result" && results.includes(String(artifact.value.attemptId))).map((artifact) => scenarioIdForRegisteredAttempt(all, artifact)).sort();
    if (JSON.stringify(actual) !== JSON.stringify(required)) throw new QaSkillsError("Retest reproduction did not retain every source occurrence", "ARTIFACT_BINDING");
    state.reproductionAttemptIds = results;
    return (await artifacts()).filter((artifact) => artifact.record.type === "test-result" && results.includes(String(artifact.value.attemptId))).map((artifact) => artifact.record) as unknown as WorkflowOperationOutputMap[Name];
  }
  if (name === "select-regression") {
    const source = resolveRuntime(runtime.changeScopeSources, input.runtime?.changeScopeSourceId, "change-scope source");
    const scope = (await artifacts()).find((artifact) => artifact.record.type === "change-scope")?.record ?? await registerChangeScope({ workspace, changes: source.changes, provenance: source.provenance });
    const selection = selectRegressionCases({ changes: source.changes, testCases: (await cases()).map((artifact) => regressionCaseFromCanonical(artifact.value)) });
    state.selection = selection;
    state.executionCaseIds = selectedCaseArtifactIds(selection, await artifacts());
    if (input.mode === "retest" && state.retestSource) {
      const sourceIds = new Set(state.retestSource.scenarios.map((scenario) => `${scenario.testCaseId}:${scenario.revisionId}:${scenario.instanceId}`));
      const all = await artifacts();
      // Invariance: `all` is read here and consulted only in the filter below; the selection artifact is
      // registered afterwards, by the `registerSelection` this branch falls through to.
      const byId = indexByArtifactId(all);
      state.executionCaseIds = state.executionCaseIds.filter((id) => {
        const value = byId.get(id)[0]?.value;
        return value === undefined || !sourceIds.has(`${asString(value.testCaseId, "selected testcase ID")}:${asString(value.revisionId, "selected testcase revision ID")}:${asString(value.instanceId, "selected testcase instance ID")}`);
      });
    }
    return registerSelection(workspace, selection, scope) as Promise<WorkflowOperationOutputMap[Name]>;
  }
  if (name === "execute-browser-test") {
    if (input.mode === "retest") {
      const results = state.executionCaseIds.length === 0
        ? (await artifacts()).filter((artifact) => artifact.record.type === "test-result" && state.reproductionAttemptIds.includes(String(artifact.value.attemptId))).map((artifact) => artifact.record)
        : await executeWithRuntime(workspace, runtime, input.runtime ?? {}, state.executionCaseIds);
      const reproduced = new Set(state.reproductionAttemptIds);
      state.regressionAttemptIds = (await artifacts()).filter((artifact) => artifact.record.type === "test-result" && !reproduced.has(String(artifact.value.attemptId))).map((artifact) => asString(artifact.value.attemptId, "regression attempt ID"));
      return results as WorkflowOperationOutputMap[Name];
    }
    if (state.executionCaseIds.length === 0) throw new QaSkillsError("Runtime execution requires imported approved canonical test cases", "ARTIFACT_BINDING");
    return executeWithRuntime(workspace, runtime, input.runtime ?? {}, state.executionCaseIds) as Promise<WorkflowOperationOutputMap[Name]>;
  }
  if (name === "collect-evidence") {
    if (input.mode === "retest") {
      const reproduced = new Set(state.reproductionAttemptIds);
      // Evidence carries its attempt inside the `subject` union; an Evidence Gap still carries it flat.
      return (await artifacts()).filter((artifact) => {
        if (artifact.record.type !== "evidence" && artifact.record.type !== "evidence-gap") return false;
        const attemptId = artifact.record.type === "evidence" ? evidenceAttemptId(artifact.value) : artifact.value.attemptId;
        return typeof attemptId === "string" && (reproduced.has(attemptId) || state.regressionAttemptIds.includes(attemptId));
      }).map((artifact) => artifact.record) as unknown as WorkflowOperationOutputMap[Name];
    }
    // Browser execution captures evidence while its session is active; this
    // adapter exposes exactly those immutable records as the collection step.
    return (await artifacts()).filter((artifact) => artifact.record.type === "evidence" || artifact.record.type === "evidence-gap").map((artifact) => artifact.record) as unknown as WorkflowOperationOutputMap[Name];
  }
  if (name === "generate-bug-report") {
    const failed = (await artifacts()).filter((artifact) => artifact.record.type === "test-result" && artifact.value.status === "FAILED");
    const generated: ArtifactRecord[] = [];
    for (const attempt of failed) {
      const id = asString(attempt.value.attemptId, "attempt ID");
      const existing = (await artifacts()).find((artifact) => (artifact.record.type === "bug-report" || artifact.record.type === "incident") && artifact.value.attemptId === id);
      if (existing) { generated.push(existing.record); continue; }
      const defect = await (await import("./generate-bug-report.js")).generateBugReport({ workspace, attemptId: id });
      generated.push(defect.record);
    }
    return generated as unknown as WorkflowOperationOutputMap[Name];
  }
  if (name === "derive-retest-verdict") {
    if (!input.retest || !state.retestSource) throw new QaSkillsError("Retest source was not resolved", "ARTIFACT_BINDING");
    return registerRuntimeRetestResult(workspace, input.retest.sourceBug, state.retestSource, state.reproductionAttemptIds, state.regressionAttemptIds) as Promise<WorkflowOperationOutputMap[Name]>;
  }
  if (name === "generate-qa-report") {
    const report = await (await import("./generate-qa-report.js")).generateQaReport({ workspace });
    return [report.gate, report.report] as unknown as WorkflowOperationOutputMap[Name];
  }
  throw new QaSkillsError(`Unknown closed workflow operation ${name}`, "ARTIFACT_BINDING");
}

async function runWorkflowWithRegistry(input: WorkflowInput, registry: WorkflowRegistry): Promise<WorkflowResult> {
  const order = operationsForMode(input.mode);
  if (input.mode === "retest" && !input.linkedRunId) throw new QaSkillsError("Retest creates a linked immutable run", "ARTIFACT_BINDING");
  if (input.mode === "regression" && !input.linkedRunId && input.retest !== undefined) throw new QaSkillsError("Retest regression must retain its linked source run", "ARTIFACT_BINDING");
  const ownsWorkspace = input.workspace === undefined;
  const workspace = input.workspace ?? await RunWorkspace.create({ root: input.root, mode: input.mode, environmentProfile: input.environmentProfile, ...(input.linkedRunId === undefined ? {} : { linkedRunId: input.linkedRunId }) });
  if (workspace.mode !== input.mode) throw new QaSkillsError("Workflow mode must match its runtime-owned workspace", "ARTIFACT_BINDING");
  if (input.linkedRunId !== undefined && workspace.linkedRunId !== input.linkedRunId) throw new QaSkillsError("Workflow linked source must match its runtime-owned workspace", "ARTIFACT_BINDING");
  const outputs: CorrelatedWorkflowOutputs = {};
  try {
    for (const name of order) {
      if (name === "register-exploration-charter") {
        if (!input.charter) throw new QaSkillsError("Exploratory workflow requires exactly one charter", "INVALID_ARTIFACT");
        outputs[name] = await registerCharter(workspace, input.charter);
        continue;
      }
      if (name === "select-regression") {
        if (!input.regression) throw new QaSkillsError("Regression workflow requires a declared change scope", "ARTIFACT_BINDING");
        if (input.regression.sourceRunId) await importRegressionCases(workspace, input.regression.sourceRunId);
        const selection = selectRegressionCases(input.regression);
        const scope = await registerChangeScope({ workspace, changes: input.regression.changes, provenance: { kind: "declared-change", reference: "unsafe-test-seam" } });
        outputs[name] = await registerSelection(workspace, selection, scope);
        continue;
      }
      if (name === "execute-browser-test") await assertApprovedCanonicalRevisions(workspace, input.approvedRevisionArtifactIds);
      if (name === "derive-retest-verdict") {
        if (!input.retest) throw new QaSkillsError("Retest workflow requires a source bug and reproduction", "ARTIFACT_BINDING");
        outputs[name] = await registerRetestResult(workspace, input.retest);
        continue;
      }
      const operation = registry[name];
      if (!operation) throw new QaSkillsError(`Workflow operation ${name} requires its typed runtime input`, "ARTIFACT_BINDING");
      const output = await operation({ name, workspace, input, outputs });
      if (output !== undefined) outputs[name] = output as never;
      if (name === "reproduce-bug") {
        if (!input.retest) throw new QaSkillsError("Retest workflow requires a source bug and reproduction", "ARTIFACT_BINDING");
        await exactRetestReproduction(workspace, input.retest);
      }
    }
    const { outcome, validation, releaseRecommendation } = await finalizeWorkflowOutcome(workspace, input.mode);
    return { runId: workspace.runId, mode: input.mode, outcome, operationOrder: order, outputs, validation, ...(releaseRecommendation === undefined ? {} : { releaseRecommendation }) };
  } finally { if (ownsWorkspace) await workspace.close(); }
}
