import { assertExplorationCharter, type ExplorationCharter } from "../exploratory/charter.js";
import { deriveRegressionOutcome, deriveRetestVerdict, sourceScenarioId, type RegressionOutcome } from "../retest/verdict.js";
import { selectRegressionCases, type RegressionSelection } from "../regression/selector.js";
import { regressionCaseFromCanonical, type ChangeScope, type RegressionCase } from "../regression/change-scope.js";
import { sha256Text } from "../core/checksum.js";
import { QaSkillsError } from "../core/errors.js";
import { RunWorkspace, type ArtifactRecord, type RegisteredWorkspaceArtifact, type WorkspaceValidation } from "../core/run-workspace.js";
import { operationsForMode, type PublicWorkflowMode, type WorkflowOperationName } from "../orchestration/modes.js";
import type { Browser } from "@playwright/test";
import type { SecretResolver } from "../browser/types.js";
import { activeBrowserSessions, executeTestInstance } from "./execute-browser-test.js";
import { createBrowserAttemptSession } from "../browser/playwright/session.js";
import { attachEvidence, captureEvidence, recordEvidenceGap } from "../evidence/collector.js";
import { annotateScreenshot } from "../evidence/annotator.js";
import { normalizeGeometry } from "../evidence/geometry.js";
import { redactText } from "../evidence/redaction.js";
import { resolveLocator } from "../browser/locator.js";
import { resolveEvidencePolicy, type EvidencePolicyLayers } from "../evidence/policy.js";
import { prepareTestData } from "./prepare-test-data.js";
import { TestDataHookRegistry } from "../test-data/hooks.js";
import { registerChangeScope } from "../regression/change-scope.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEntityId } from "../core/ids.js";
import { validateArtifact } from "../contracts/validator.js";

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
export type WorkflowResult = Readonly<{ runId: string; mode: PublicWorkflowMode; outcome: "AWAITING_RUNTIME" | WorkflowTerminalStatus; operationOrder: readonly WorkflowOperationName[]; outputs: Readonly<CorrelatedWorkflowOutputs>; validation: WorkspaceValidation }>;

/** A checksum-bound immutable source record.  Public workflows never accept a raw draft. */
export type RegisteredArtifactRef = Readonly<{ artifactId: string; sha256: string }>;
export type CanonicalPlanBundleRef = Readonly<{ sourceRunId: string; artifacts: readonly RegisteredArtifactRef[] }>;
export type QaRuntimeRegistry = Readonly<{
  browserManagers?: Readonly<Record<string, Readonly<{ browser: Browser; annotateFailures?: boolean }>>>;
  secretResolvers?: Readonly<Record<string, SecretResolver>>;
  testDataRegistries?: Readonly<Record<string, TestDataHookRegistry>>;
  evidencePolicies?: Readonly<Record<string, EvidencePolicyLayers>>;
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
  runtime?: Readonly<{ browserManagerId?: string; secretResolverId?: string; testDataRegistryId?: string; testDataHookIds?: readonly string[]; evidencePolicyId?: string; changeScopeSourceId?: string }>;
  charter?: ExplorationCharter;
  retest?: Readonly<{ sourceBug: RegisteredArtifactRef }>;
}>;

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function artifactRecord(value: unknown): value is ArtifactRecord {
  return record(value) && typeof value.id === "string" && typeof value.sha256 === "string" && typeof value.type === "string" && typeof value.relativePath === "string";
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

async function assertRegisteredArtifacts(workspace: RunWorkspace, output: WorkflowOutput | readonly ArtifactRecord[]): Promise<void> {
  const records = Array.isArray(output) ? output.filter(artifactRecord) : artifactRecord(output) ? [output] : [];
  const artifacts = await workspace.readRegisteredArtifacts();
  if (records.some((item) => !artifacts.some((artifact) => artifact.record.id === item.id && artifact.record.sha256 === item.sha256))) throw new QaSkillsError("Workflow operation output is not a registered immutable artifact", "ARTIFACT_BINDING");
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
  for (const result of output) {
    const attempt = artifacts.find((item) => item.record.id === result.id);
    const attemptId = attempt === undefined ? undefined : String(attempt.value.attemptId);
    if (!attemptId || !artifacts.some((item) => (item.record.type === "evidence" || item.record.type === "evidence-gap") && String(item.value.attemptId) === attemptId)) throw new QaSkillsError("Execution result lacks registered evidence or evidence gap", "ARTIFACT_BINDING");
  }
}

async function assertFailureDispositionPostcondition(workspace: RunWorkspace, output: readonly ArtifactRecord[]): Promise<void> {
  await assertRegisteredArtifacts(workspace, output);
  const artifacts = await workspace.readRegisteredArtifacts();
  const failed = artifacts.filter((artifact) => artifact.record.type === "test-result" && artifact.value.status === "FAILED");
  const unresolved = failed.filter((attempt) => !artifacts.some((artifact) => (artifact.record.type === "bug-report" || artifact.record.type === "incident") && artifact.value.attemptId === attempt.value.attemptId));
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function workflowStateChecksum(state: WorkflowStateSnapshot): string { return sha256Text(canonicalJson(state)); }

function registeredRef(artifacts: readonly RegisteredWorkspaceArtifact[], id: string | undefined): RegisteredArtifactRef | undefined {
  const artifact = id === undefined ? undefined : artifacts.find((item) => item.record.id === id);
  return artifact === undefined ? undefined : { artifactId: artifact.record.id, sha256: artifact.record.sha256 };
}

async function snapshotWorkflowState(state: WorkflowExecutionState): Promise<WorkflowStateSnapshot> {
  const artifacts = await state.workspace.readRegisteredArtifacts();
  const refs = (ids: readonly string[]) => ids.map((id) => registeredRef(artifacts, id)).filter((item): item is RegisteredArtifactRef => item !== undefined);
  const selectedExecutionCases = state.selection === undefined ? state.executionCaseIds : selectedCaseArtifactIds(state.selection, artifacts);
  if (state.selection !== undefined && selectedExecutionCases.length !== state.selection.selected.length) throw new QaSkillsError("Regression selection does not resolve every selected canonical testcase", "ARTIFACT_BINDING");
  return {
    importedArtifacts: refs(state.importedArtifactIds), executionCases: refs(selectedExecutionCases),
    reproductionAttempts: refs(state.reproductionAttemptIds.map((attemptId) => artifacts.find((item) => item.record.type === "test-result" && item.value.attemptId === attemptId)?.record.id).filter((id): id is string => id !== undefined)),
    regressionAttempts: refs(state.regressionAttemptIds.map((attemptId) => artifacts.find((item) => item.record.type === "test-result" && item.value.attemptId === attemptId)?.record.id).filter((id): id is string => id !== undefined)),
    exploratoryFindings: refs(state.exploratoryFindingIds),
    ...(state.selection === undefined ? {} : { selection: registeredRef(artifacts, artifacts.find((item) => item.record.type === "regression-selection")?.record.id)! }),
    ...(state.retestSource === undefined ? {} : { retestSource: state.retestSource }),
    ...(state.charterArtifactId === undefined ? {} : { charter: registeredRef(artifacts, state.charterArtifactId)! }),
  };
}

function checkpointState(value: unknown): WorkflowStateSnapshot {
  if (!record(value)) throw new QaSkillsError("Workflow checkpoint state is invalid", "ARTIFACT_BINDING");
  const refs = (key: string): readonly RegisteredArtifactRef[] => Array.isArray(value[key]) && value[key].every((item) => record(item) && typeof item.artifactId === "string" && typeof item.sha256 === "string") ? value[key] as RegisteredArtifactRef[] : (() => { throw new QaSkillsError("Workflow checkpoint state references are invalid", "ARTIFACT_BINDING"); })();
  const ref = (key: string): RegisteredArtifactRef | undefined => value[key] === undefined ? undefined : record(value[key]) && typeof value[key].artifactId === "string" && typeof value[key].sha256 === "string" ? value[key] as RegisteredArtifactRef : (() => { throw new QaSkillsError("Workflow checkpoint state reference is invalid", "ARTIFACT_BINDING"); })();
  return { importedArtifacts: refs("importedArtifacts"), executionCases: refs("executionCases"), reproductionAttempts: refs("reproductionAttempts"), regressionAttempts: refs("regressionAttempts"), exploratoryFindings: refs("exploratoryFindings"), ...(ref("selection") === undefined ? {} : { selection: ref("selection")! }), ...(ref("charter") === undefined ? {} : { charter: ref("charter")! }), ...(value.retestSource === undefined ? {} : { retestSource: value.retestSource as RetestSource }) };
}

async function checkpointWorkflow(workspace: RunWorkspace, input: QaWorkflowInput): Promise<WorkflowCheckpoint> {
  const checkpoints = (await workspace.readRegisteredArtifacts()).filter((artifact) => artifact.record.type === "workflow-checkpoint");
  const checksum = workflowInputChecksum(input);
  if (checkpoints.length > 0) {
    const latest = [...checkpoints].sort((left, right) => Number(right.value.revision) - Number(left.value.revision))[0];
    if (!latest || latest.value.inputChecksum !== checksum) throw new QaSkillsError("Resume input does not match its durable workflow checkpoint", "ARTIFACT_BINDING");
    return { record: latest.record, completedOperations: Array.isArray(latest.value.completedOperations) ? latest.value.completedOperations as WorkflowOperationName[] : [], operationOutputs: record(latest.value.operationOutputs) ? latest.value.operationOutputs as Record<string, readonly RegisteredArtifactRef[]> : {}, state: checkpointState(latest.value.state) };
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

/**
 * Imports a checked, terminal canonical planning bundle in dependency order.
 * Relationships are rebuilt locally rather than copied as foreign manifest IDs.
 */
export async function importCanonicalPlanBundle(workspace: RunWorkspace, bundle: CanonicalPlanBundleRef): Promise<ReadonlyMap<string, ArtifactRecord>> {
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
    const accepted = new Set(["requirement-analysis", "test-plan", "test-case", "coverage-obligation"]);
    if (selected.some((item) => !accepted.has(item.record.type))) throw new QaSkillsError("Canonical plan bundle contains a non-planning artifact", "ARTIFACT_BINDING");
    const imported = new Map<string, ArtifactRecord>();
    const environment = (await workspace.readRegisteredArtifacts()).find((item) => item.record.type === "environment-profile")?.value;
    if (typeof environment?.classification !== "string") throw new QaSkillsError("Import target has no valid environment", "ARTIFACT_BINDING");
    const copy = async (type: "requirement-analysis" | "test-plan" | "test-case" | "coverage-obligation", item: (typeof selected)[number]): Promise<void> => {
      const value = JSON.parse(JSON.stringify(item.value)) as Record<string, unknown>;
      if (type === "coverage-obligation") {
        const sourceAnalysis = asString(value.requirementAnalysisArtifactId, "coverage obligation requirement analysis ID");
        const localAnalysis = imported.get(sourceAnalysis);
        if (!localAnalysis) throw new QaSkillsError("Canonical coverage obligation precedes its requirement analysis", "ARTIFACT_BINDING");
        value.requirementAnalysisArtifactId = localAnalysis.id;
      }
      if (type === "test-plan") {
        // A plan's approval is always re-derived in the target workspace from
        // its imported requirement analyses and target environment.  Carrying
        // the source decision across the public boundary would be a
        // self-asserted value and is rejected by workspace registration.
        delete value.approvalDecision;
      }
      const relationships = item.record.relationships.map((id) => imported.get(id)?.id).filter((id): id is string => id !== undefined);
      const registered = await workspace.registerArtifactValue({ type, value, relationships, provenance: `runtime-import:${bundle.sourceRunId}:${item.record.id}` });
      imported.set(item.record.id, registered);
    };
    for (const type of ["requirement-analysis", "test-plan", "test-case", "coverage-obligation"] as const) for (const item of selected.filter((candidate) => candidate.record.type === type)) await copy(type, item);
    return imported;
  } finally { await source.close(); }
}

function resolveRuntime<T>(items: Readonly<Record<string, T>> | undefined, id: string | undefined, label: string): T {
  if (!id || !items?.[id]) throw new QaSkillsError(`Workflow runtime ${label} is not configured`, "ARTIFACT_BINDING");
  return items[id];
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function redactionRegions(value: unknown): readonly { x: number; y: number; width: number; height: number }[] {
  return Array.isArray(value) && value.every((item) => record(item) && [item.x, item.y, item.width, item.height].every((part) => typeof part === "number"))
    ? value as { x: number; y: number; width: number; height: number }[] : [];
}

/** Environment identity is canonical; host policy may only add protection/redaction. */
function capturePolicyForEnvironment(environment: Record<string, unknown>, host: EvidencePolicyLayers) {
  const profile = record(environment.evidenceProtection) ? environment.evidenceProtection : {};
  const runtime = host.protection ?? {};
  return {
    protectedEnvironment: environment.classification === "production" || profile.protected === true || runtime.protectedEnvironment === true,
    redaction: {
      domSelectors: [...new Set([...stringArray(profile.domSelectors), ...stringArray(runtime.domSelectors)])],
      regions: [...redactionRegions(profile.regions), ...redactionRegions(runtime.regions)],
    },
  };
}

async function executeWithRuntime(workspace: RunWorkspace, runtime: QaRuntimeRegistry, ids: NonNullable<QaWorkflowInput["runtime"]>, caseArtifactIds: readonly string[]): Promise<readonly ArtifactRecord[]> {
  const manager = resolveRuntime(runtime.browserManagers, ids.browserManagerId, "browser manager");
  const resolver = ids.secretResolverId === undefined ? undefined : resolveRuntime(runtime.secretResolvers, ids.secretResolverId, "secret resolver");
  const policy = resolveEvidencePolicy(ids.evidencePolicyId === undefined ? {} : resolveRuntime(runtime.evidencePolicies, ids.evidencePolicyId, "evidence policy"));
  const policyLayers = ids.evidencePolicyId === undefined ? {} : resolveRuntime(runtime.evidencePolicies, ids.evidencePolicyId, "evidence policy");
  const environment = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "environment-profile")?.value;
  if (!record(environment)) throw new QaSkillsError("Runtime execution requires a registered environment profile", "ARTIFACT_BINDING");
  const capturePolicy = capturePolicyForEnvironment(environment, policyLayers);
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
      if (!artifacts.some((artifact) => (artifact.record.type === "evidence" || artifact.record.type === "evidence-gap") && artifact.value.attemptId === attemptId)) {
        await attachEvidence({ workspace, attemptId, callerAttemptId: attemptId, telemetry: "log", protectedEnvironment: false, testcaseId: asString(testCase.value.testCaseId, "test case ID") });
      }
      results.push(registered.record); continue;
    }
    const attemptId = `ATT-${workspace.runId}-${createEntityId()}`;
    const traceActive = policy.trace === "on-failure" || policy.trace === "always" || policy.trace === "required";
    await executeTestInstance({ workspace, browser: manager.browser, attemptId, testCaseArtifactId, ...(resolver === undefined ? {} : { resolveSecret: resolver }), ...(traceActive ? { onSessionActive: async ({ session }) => { await session.context.tracing.start({ screenshots: true, snapshots: true }); } } : {}), onBeforeSessionClose: async ({ attempt, session }) => {
      const retainTrace = policy.trace === "always" || policy.trace === "required" || (policy.trace === "on-failure" && attempt.status !== "PASSED");
      if (traceActive) {
        const unsafeTraceReason = capturePolicy.protectedEnvironment
          ? "Trace bytes are unavailable for a protected environment because deterministic archive redaction cannot be proven"
          : session.secrets.size > 0
            ? "Trace bytes are unavailable after secret resolution because deterministic archive redaction cannot be proven"
            : undefined;
        if (!retainTrace || unsafeTraceReason !== undefined) {
          await session.context.tracing.stop();
          if (retainTrace && unsafeTraceReason !== undefined) await recordEvidenceGap({ workspace, attemptId, reason: unsafeTraceReason, affectedClaim: "trace capture" });
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
            const viewport = session.page.viewportSize() ?? { width: 1, height: 1 };
            const scroll = await session.page.evaluate(() => {
              const page = globalThis as unknown as { scrollX: number; scrollY: number };
              return { x: Math.max(0, page.scrollX), y: Math.max(0, page.scrollY) };
            });
            const safeUrl = redactText(session.page.url(), [...session.secrets]);
            await workspace.registerEvidenceBundle({
              binaries: [{ filename: `${evidenceId}-trace.zip`, contents: bytes, mediaType: "application/zip", captureType: "trace" }],
              relationships: [resultArtifact.record.id],
              provenance: "runtime",
              descriptor: (binaries) => {
                const binary = binaries[0]!;
                const value = { artifactType: "evidence", schemaVersion: "1.0.0", producerVersion: "0.1.0", evidenceId, runId: workspace.runId, attemptId, testCaseId: String(testCase.value.testCaseId), testCaseRevisionId: String(testCase.value.revisionId), testCaseInstanceId: String(testCase.value.instanceId), kind: "trace", capturedAt, sha256: binary.sha256, relativePath: binary.relativePath, mediaType: binary.mediaType, binaryArtifactIds: [binary.id], binaryArtifacts: [{ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType }], provenance: { captureType: "trace", dimensions: viewport, dpr: 1, scroll, clip: { x: 0, y: 0, width: viewport.width, height: viewport.height }, url: safeUrl, viewport, browser: "playwright", build: "runtime", capturedAt, testcaseId: String(testCase.value.testCaseId) } };
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
        const evidence = await attachEvidence({ workspace, attemptId, callerAttemptId: attemptId, telemetry, protectedEnvironment: capturePolicy.protectedEnvironment, testcaseId: asString(testCase.value.testCaseId, "test case ID") });
        void evidence;
      };
      if (policy.logs !== "forbidden" && policy.logs !== "off") await attachment("log");
      if (policy.console !== "forbidden" && policy.console !== "off") await attachment("console");
      if (policy.network !== "forbidden" && policy.network !== "off") await attachment("network");
      if (policy.screenshot === "always" || policy.screenshot === "required" || (policy.screenshot === "on-failure" && attempt.status !== "PASSED")) {
        const evidence = await captureEvidence({ workspace, attemptId, callerAttemptId: attemptId, protectedEnvironment: capturePolicy.protectedEnvironment, redaction: capturePolicy.redaction, testcaseId: asString(testCase.value.testCaseId, "test case ID") });
        if (manager.annotateFailures === true && attempt.status !== "PASSED" && evidence.kind === "evidence") {
          const failed = attempt.steps.find((step) => step.status === "FAILED" && step.failedAssertion !== undefined && "locator" in step.failedAssertion);
          if (failed?.failedAssertion && "locator" in failed.failedAssertion) {
            const box = await resolveLocator(session.page, failed.failedAssertion.locator).boundingBox();
            const raw = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.id === evidence.descriptorArtifactId)?.value;
            const provenance = record(raw?.provenance) ? raw.provenance : undefined;
            const dimensions = record(provenance?.dimensions) ? provenance.dimensions : undefined;
            const scroll = record(provenance?.scroll) ? provenance.scroll : undefined;
            const clip = record(provenance?.clip) ? provenance.clip : undefined;
            if (box && dimensions && scroll && clip && typeof dimensions.width === "number" && typeof dimensions.height === "number" && typeof provenance?.dpr === "number" && typeof scroll.x === "number" && typeof scroll.y === "number" && typeof clip.x === "number" && typeof clip.y === "number" && typeof clip.width === "number" && typeof clip.height === "number") {
              const locator = JSON.stringify(failed.failedAssertion.locator);
              const annotations = normalizeGeometry({ image: { width: dimensions.width, height: dimensions.height, dpr: provenance.dpr, scrollX: scroll.x, scrollY: scroll.y, clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height } }, annotations: [{ id: `failure-${failed.stepId}`, box, ...(failed.error === undefined ? {} : { label: failed.error }), locator }] });
              await annotateScreenshot({ workspace, rawEvidenceDescriptorId: evidence.descriptorArtifactId, rawBinaryArtifactId: evidence.binaryArtifactId, annotations });
            }
          }
        }
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
  return sourceScenarioId({ testCaseId: asString(attempt.value.testCaseId, "retest testcase ID"), revisionId: asString(attempt.value.testCaseRevisionId, "retest testcase revision ID"), instanceId: asString(attempt.value.testCaseInstanceId, "retest testcase instance ID"), parameters: record(testCase.value.parameters) ? testCase.value.parameters : {} });
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
    const provenance = record(bug.value.provenance) ? bug.value.provenance : {};
    const sourceAttemptIds = Array.isArray(provenance.sourceAttemptIds) && provenance.sourceAttemptIds.every((id) => typeof id === "string") ? provenance.sourceAttemptIds : [asString(bug.value.attemptId, "source bug attempt ID")];
    if (sourceAttemptIds.length === 0 || new Set(sourceAttemptIds).size !== sourceAttemptIds.length) throw new QaSkillsError("Selected bug revision has invalid exact reproduction references", "ARTIFACT_BINDING");
    const scenarios = sourceAttemptIds.map((attemptId) => {
      const attempt = artifacts.find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === attemptId);
      if (!attempt || attempt.value.failureClassification !== "PRODUCT_DEFECT") throw new QaSkillsError("Selected bug revision references an invalid product reproduction", "ARTIFACT_BINDING");
      const caseId = attempt.record.relationships.find((id) => artifacts.some((candidate) => candidate.record.id === id && candidate.record.type === "test-case"));
      const testCase = caseId === undefined ? undefined : artifacts.find((candidate) => candidate.record.id === caseId && candidate.record.type === "test-case");
      if (!testCase || testCase.value.testCaseId !== attempt.value.testCaseId || testCase.value.revisionId !== attempt.value.testCaseRevisionId || testCase.value.instanceId !== attempt.value.testCaseInstanceId) throw new QaSkillsError("Source attempt is not bound to its exact canonical testcase instance", "ARTIFACT_BINDING");
      return { sourceAttemptArtifactId: attempt.record.id, sourceTestCaseArtifactId: testCase.record.id, testCaseId: asString(attempt.value.testCaseId, "source testcase ID"), revisionId: asString(attempt.value.testCaseRevisionId, "source testcase revision ID"), instanceId: asString(attempt.value.testCaseInstanceId, "source testcase instance ID"), parameters: record(testCase.value.parameters) ? testCase.value.parameters : {} };
    });
    return { bugId: asString(bug.value.bugId, "source bug ID"), scenarios };
  } finally { await source.close(); }
}

async function registerRuntimeRetestResult(workspace: RunWorkspace, reference: RegisteredArtifactRef, source: RetestSource, reproductionAttemptIds: readonly string[], regressionAttemptIds: readonly string[]): Promise<ArtifactRecord> {
  const artifacts = await workspace.readRegisteredArtifacts();
  const reproduction = reproductionAttemptIds.map((attemptId) => artifacts.find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === attemptId));
  const expectedOccurrences = source.scenarios.map(sourceScenarioId).sort();
  const actualOccurrences = reproduction.map((attempt) => attempt === undefined ? "" : scenarioIdForRegisteredAttempt(artifacts, attempt)).sort();
  if (reproduction.length === 0 || reproduction.some((attempt) => !attempt) || JSON.stringify(actualOccurrences) !== JSON.stringify(expectedOccurrences)) throw new QaSkillsError("Retest reproduction did not execute every exact immutable source scenario occurrence", "ARTIFACT_BINDING");
  const regression = regressionAttemptIds.map((attemptId) => artifacts.find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === attemptId)).filter((attempt): attempt is NonNullable<typeof attempt> => attempt !== undefined);
  const regressionOutcome = deriveRegressionOutcome(regression.map((attempt) => asString(attempt.value.status, "regression execution status")));
  const reproductionScenarios = reproduction.map((attempt, index) => ({ scenarioId: attempt === undefined ? "" : scenarioIdForRegisteredAttempt(artifacts, attempt), sourceAttemptArtifactId: source.scenarios[index]!.sourceAttemptArtifactId, sourceTestCaseArtifactId: source.scenarios[index]!.sourceTestCaseArtifactId, attemptId: asString(attempt?.value.attemptId, "reproduction attempt ID"), status: asString(attempt?.value.status, "reproduction execution status") }));
  const verdict = deriveRetestVerdict({ originalBugId: source.bugId, reproductionStatuses: reproductionScenarios.map((scenario) => scenario.status), scenarioIds: reproductionScenarios.map((scenario) => scenario.scenarioId), regressionOutcome });
  return workspace.registerArtifactValue({ type: "retest-result", value: { artifactType: "retest-result", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: workspace.runId, sourceRunId: workspace.linkedRunId, sourceBugArtifactId: reference.artifactId, sourceBugArtifactSha256: reference.sha256, bugId: source.bugId, reproductionAttemptIds: [...reproductionAttemptIds], reproductionScenarios, regressionAttemptIds: [...regressionAttemptIds], verdict: verdict.verdict, regressionOutcome }, relationships: [...reproduction, ...regression].map((attempt) => attempt?.record.id).filter((id): id is string => id !== undefined), provenance: "runtime" });
}

async function assertApprovedCanonicalRevisions(workspace: RunWorkspace, ids: readonly string[] | undefined): Promise<void> {
  const artifacts = await workspace.readRegisteredArtifacts();
  const testCases = artifacts.filter((artifact) => artifact.record.type === "test-case");
  const requested = ids === undefined ? testCases : ids.map((id) => artifacts.find((artifact) => artifact.record.id === id)).filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== undefined);
  if (ids !== undefined && requested.length !== ids.length) throw new QaSkillsError("Execution requires caller-identified registered canonical revisions", "ARTIFACT_BINDING");
  if (requested.length === 0) throw new QaSkillsError("Execution requires at least one approved canonical test case revision", "ARTIFACT_BINDING");
  for (const testCase of requested) {
    if (testCase.record.type !== "test-case") throw new QaSkillsError("Execution accepts only registered test case revisions", "ARTIFACT_BINDING");
    const plans = artifacts.filter((plan) => plan.record.type === "test-plan" && testCase.record.relationships.includes(plan.record.id));
    const approved = plans.some((plan) => record(plan.value.approvalDecision) && plan.value.approvalDecision.approved === true
      && Array.isArray(plan.value.testCases) && plan.value.testCases.some((entry) => record(entry) && entry.testCaseId === testCase.value.testCaseId));
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

/** Bounded exploration uses a runtime-owned browser context, never an agent callback or arbitrary script. */
async function executeExploration(workspace: RunWorkspace, runtime: QaRuntimeRegistry, ids: NonNullable<QaWorkflowInput["runtime"]>, charter: ExplorationCharter): Promise<readonly ArtifactRecord[]> {
  const manager = resolveRuntime(runtime.browserManagers, ids.browserManagerId, "browser manager");
  const environment = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "environment-profile")?.value;
  if (!record(environment) || typeof environment.baseUrl !== "string") throw new QaSkillsError("Exploration requires its registered environment", "ARTIFACT_BINDING");
  const policyLayers = ids.evidencePolicyId === undefined ? {} : resolveRuntime(runtime.evidencePolicies, ids.evidencePolicyId, "evidence policy");
  const capturePolicy = capturePolicyForEnvironment(environment, policyLayers);
  const attemptId = `EXP-${workspace.runId}-${createEntityId()}`;
  const session = await createBrowserAttemptSession(manager.browser, { testCaseId: `EXP-${charter.charterId}`, revisionId: charter.charterId, instanceId: charter.charterId });
  activeBrowserSessions.set(attemptId, session);
  try {
    const started = Date.now();
    const scope = new Set(charter.scope.map((target) => new URL(target, asString(environment.baseUrl, "environment base URL")).toString()));
    const observations: string[] = [];
    for (const action of charter.actions.slice(0, charter.actionBudget)) {
      if (Date.now() - started > charter.timeBudgetMinutes * 60_000) break;
      if (action.sideEffect === "write") throw new QaSkillsError(`Exploration action ${action.actionId} requests an unsafe side effect`, "ARTIFACT_BINDING");
      if (!charter.safetyRules.includes(action.safetyRuleId)) throw new QaSkillsError(`Exploration action ${action.actionId} lacks safety authorization`, "ARTIFACT_BINDING");
      const target = new URL(action.target, environment.baseUrl);
      if (!scope.has(target.toString())) throw new QaSkillsError(`Exploration action ${action.actionId} is outside the declared scope`, "ARTIFACT_BINDING");
      const response = await session.page.goto(target.toString());
      observations.push(`Navigation telemetry for ${target.pathname}: HTTP ${response?.status() ?? "unavailable"}.`);
      if (action.stopCondition !== undefined || charter.stopConditions.includes("after-action")) break;
    }
    if (observations.length === 0) throw new QaSkillsError("Exploration stopped before any authorized action could be observed", "ARTIFACT_BINDING");
    const evidence = await captureEvidence({ workspace, attemptId, callerAttemptId: attemptId, protectedEnvironment: capturePolicy.protectedEnvironment, redaction: capturePolicy.redaction, testcaseId: `EXP-${charter.charterId}` });
    const charterRecord = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "exploration-charter");
    if (!charterRecord) throw new QaSkillsError("Exploration finding requires its registered charter", "ARTIFACT_BINDING");
    const finding = await workspace.registerArtifactValue({ type: "exploratory-finding", value: {
      artifactType: "exploratory-finding", schemaVersion: "1.0.0", producerVersion: "0.1.0", findingId: `EXP-FIND-${createEntityId()}`, runId: workspace.runId, charterId: charter.charterId,
      observation: observations.join(" "), authority: "EXPLORATORY", satisfiesCoverage: false,
    }, relationships: [charterRecord.record.id, evidence.descriptorArtifactId], provenance: "runtime" });
    return [await workspace.readArtifactRecord(evidence.descriptorArtifactId), finding];
  } finally {
    activeBrowserSessions.delete(attemptId);
    session.secrets.clear();
    await session.context.close();
  }
}

async function registerSelection(workspace: RunWorkspace, selection: RegressionSelection, changeScope: ArtifactRecord): Promise<ArtifactRecord> {
  const artifacts = await workspace.readRegisteredArtifacts();
  const decisions = [...selection.selected, ...selection.excluded];
  const relationships = decisions.map((decision) => artifacts.filter((artifact) => artifact.record.type === "test-case" && artifact.value.testCaseId === decision.testCaseId && artifact.value.revisionId === decision.revisionId && artifact.value.instanceId === decision.instanceId)).flat();
  if (relationships.length !== decisions.length) throw new QaSkillsError("Regression selection requires every decision to bind one registered canonical test case revision", "ARTIFACT_BINDING");
  return workspace.registerArtifactValue({ type: "regression-selection", value: {
    artifactType: "regression-selection", schemaVersion: "1.0.0", producerVersion: "0.1.0", selectionId: `REG-${workspace.runId}`, runId: workspace.runId,
    changeScopeArtifactId: changeScope.id, changeScopeSha256: changeScope.sha256, decisionChecksum: sha256Text(JSON.stringify(selection)), ...selection,
  }, relationships: [changeScope.id, ...relationships.map((artifact) => artifact.record.id)], provenance: "runtime" });
}

function selectedCaseArtifactIds(selection: RegressionSelection, artifacts: readonly RegisteredWorkspaceArtifact[]): string[] {
  return selection.selected.flatMap((decision) => artifacts.filter((artifact) => artifact.record.type === "test-case" && artifact.value.testCaseId === decision.testCaseId && artifact.value.revisionId === decision.revisionId && artifact.value.instanceId === decision.instanceId).map((artifact) => artifact.record.id));
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
  const reproduction = input.reproductionAttemptIds.map((attemptId) => registered.find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === attemptId));
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

/** Finalizes once and derives the returned outcome from the same facts persisted in run metadata. */
export async function finalizeWorkflowOutcome(workspace: RunWorkspace, mode: PublicWorkflowMode): Promise<{ outcome: Extract<WorkflowTerminalStatus, "COMPLETED" | "COMPLETED_WITH_FAILURES">; validation: WorkspaceValidation }> {
  const hasExecutionFailures = (await workspace.readRegisteredArtifacts()).some((artifact) => artifact.record.type === "test-result" && artifact.value.status !== "PASSED");
  const validation = await workspace.finalize(mode, hasExecutionFailures ? "COMPLETED_WITH_FAILURES" : undefined);
  return { outcome: hasExecutionFailures || !validation.valid ? "COMPLETED_WITH_FAILURES" : "COMPLETED", validation };
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
  const resolved = refs.map((reference) => artifacts.find((artifact) => artifact.record.id === reference.artifactId && artifact.record.sha256 === reference.sha256));
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
    const selectedRelationships = state.selection.selected.map((decision) => all.filter((artifact) => artifact.record.type === "test-case" && selection.record.relationships.includes(artifact.record.id) && artifact.value.testCaseId === decision.testCaseId && artifact.value.revisionId === decision.revisionId && artifact.value.instanceId === decision.instanceId));
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
  if (!(await state.workspace.readRegisteredArtifacts()).some((artifact) => artifact.record.type === "test-case")) {
    const imported = await importCanonicalPlanBundle(state.workspace, state.input.bundle);
    state.importedArtifactIds = [...imported.values()].map((artifact) => artifact.id);
  }
  if (state.executionCaseIds.length === 0) state.executionCaseIds = (await state.workspace.readRegisteredArtifacts()).filter((artifact) => artifact.record.type === "test-case").map((artifact) => artifact.record.id);
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
    const { outcome, validation } = await finalizeWorkflowOutcome(workspace, input.mode);
    return { runId: workspace.runId, mode: input.mode, outcome, operationOrder: order, outputs, validation };
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
    const exact = source.scenarios.map((scenario) => available.find((artifact) => artifact.value.testCaseId === scenario.testCaseId && artifact.value.revisionId === scenario.revisionId && artifact.value.instanceId === scenario.instanceId));
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
      state.executionCaseIds = state.executionCaseIds.filter((id) => {
        const value = all.find((artifact) => artifact.record.id === id)?.value;
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
    if (input.mode === "exploratory") {
      if (!input.charter) throw new QaSkillsError("Exploratory workflow requires exactly one charter", "INVALID_ARTIFACT");
      const records = await executeExploration(workspace, runtime, input.runtime ?? {}, input.charter);
      state.exploratoryFindingIds = records.filter((item) => item.type === "exploratory-finding").map((item) => item.id);
      return records as WorkflowOperationOutputMap[Name];
    }
    if (input.mode === "retest") {
      const reproduced = new Set(state.reproductionAttemptIds);
      return (await artifacts()).filter((artifact) => (artifact.record.type === "evidence" || artifact.record.type === "evidence-gap") && (reproduced.has(String(artifact.value.attemptId)) || state.regressionAttemptIds.includes(String(artifact.value.attemptId)))).map((artifact) => artifact.record) as unknown as WorkflowOperationOutputMap[Name];
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
    const { outcome, validation } = await finalizeWorkflowOutcome(workspace, input.mode);
    return { runId: workspace.runId, mode: input.mode, outcome, operationOrder: order, outputs, validation };
  } finally { if (ownsWorkspace) await workspace.close(); }
}
