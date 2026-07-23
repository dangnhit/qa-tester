import { assertExplorationCharter, type ExplorationCharter } from "../exploratory/charter.js";
import { deriveRetestVerdict, type RegressionOutcome } from "../retest/verdict.js";
import { selectRegressionCases, type RegressionSelection } from "../regression/selector.js";
import type { ChangeScope, RegressionCase } from "../regression/change-scope.js";
import { QaSkillsError } from "../core/errors.js";
import { RunWorkspace, type ArtifactRecord, type WorkspaceValidation } from "../core/run-workspace.js";
import { operationsForMode, type PublicWorkflowMode, type WorkflowOperationName } from "../orchestration/modes.js";

export type WorkflowOperation = (context: Readonly<{ name: WorkflowOperationName; workspace: RunWorkspace; input: WorkflowInput; outputs: ReadonlyMap<WorkflowOperationName, unknown> }>) => Promise<unknown>;
export type WorkflowInput = Readonly<{
  root: string;
  mode: PublicWorkflowMode;
  environmentProfile: Record<string, unknown>;
  /** A caller may supply an active runtime-owned workspace containing canonical inputs. */
  workspace?: RunWorkspace;
  linkedRunId?: string;
  approvedRevisionArtifactIds?: readonly string[];
  charter?: ExplorationCharter;
  regression?: Readonly<{ changes: readonly ChangeScope[]; testCases: readonly RegressionCase[] }>;
  retest?: Readonly<{ sourceBugArtifactId: string; reproductionAttemptIds: readonly string[]; regressionOutcome?: RegressionOutcome }>;
}>;
export type WorkflowResult = Readonly<{ runId: string; mode: PublicWorkflowMode; operationOrder: readonly WorkflowOperationName[]; outputs: ReadonlyMap<WorkflowOperationName, unknown>; validation: WorkspaceValidation }>;

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

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

async function registerSelection(workspace: RunWorkspace, selection: RegressionSelection): Promise<ArtifactRecord> {
  const artifacts = await workspace.readRegisteredArtifacts();
  const decisions = [...selection.selected, ...selection.excluded];
  const relationships = decisions.map((decision) => artifacts.filter((artifact) => artifact.record.type === "test-case" && artifact.value.testCaseId === decision.testCaseId && artifact.value.revisionId === decision.revisionId)).flat();
  if (relationships.length !== decisions.length) throw new QaSkillsError("Regression selection requires every decision to bind one registered canonical test case revision", "ARTIFACT_BINDING");
  return workspace.registerArtifactValue({ type: "regression-selection", value: {
    artifactType: "regression-selection", schemaVersion: "1.0.0", producerVersion: "0.1.0", selectionId: `REG-${workspace.runId}`, runId: workspace.runId, ...selection,
  }, relationships: relationships.map((artifact) => artifact.record.id), provenance: "runtime" });
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
    sourceBugArtifactId: input.sourceBugArtifactId, bugId: verdict.bugId, reproductionAttemptIds: [...input.reproductionAttemptIds], verdict: verdict.verdict,
    ...(verdict.regressionOutcome === undefined ? {} : { regressionOutcome: verdict.regressionOutcome }),
  }, relationships: (await workspace.readRegisteredArtifacts()).filter((artifact) => artifact.record.type === "test-result" && input.reproductionAttemptIds.includes(String(artifact.value.attemptId))).map((artifact) => artifact.record.id), provenance: "runtime" });
}

/** Executes only typed, dependency-declared runtime operations. It never invokes shells or Skill Adapters. */
type WorkflowRegistry = Readonly<Partial<Record<WorkflowOperationName, WorkflowOperation>>>;

const runtimeRegistry: WorkflowRegistry = {
  "generate-qa-report": async ({ workspace }) => (await import("./generate-qa-report.js")).generateQaReport({ workspace }),
};

/** Test-only factory seam. Public callers cannot inject arbitrary operation callbacks. */
export function createWorkflowRunner(registry: WorkflowRegistry): (input: WorkflowInput) => Promise<WorkflowResult> {
  return (input) => runWorkflowWithRegistry(input, registry);
}

export function runWorkflow(input: WorkflowInput): Promise<WorkflowResult> {
  return runWorkflowWithRegistry(input, runtimeRegistry);
}

async function runWorkflowWithRegistry(input: WorkflowInput, registry: WorkflowRegistry): Promise<WorkflowResult> {
  const order = operationsForMode(input.mode);
  if (input.mode === "retest" && !input.linkedRunId) throw new QaSkillsError("Retest creates a linked immutable run", "ARTIFACT_BINDING");
  if (input.mode === "regression" && !input.linkedRunId && input.retest !== undefined) throw new QaSkillsError("Retest regression must retain its linked source run", "ARTIFACT_BINDING");
  const ownsWorkspace = input.workspace === undefined;
  const workspace = input.workspace ?? await RunWorkspace.create({ root: input.root, mode: input.mode, environmentProfile: input.environmentProfile, ...(input.linkedRunId === undefined ? {} : { linkedRunId: input.linkedRunId }) });
  if (workspace.mode !== input.mode) throw new QaSkillsError("Workflow mode must match its runtime-owned workspace", "ARTIFACT_BINDING");
  if (input.linkedRunId !== undefined && workspace.linkedRunId !== input.linkedRunId) throw new QaSkillsError("Workflow linked source must match its runtime-owned workspace", "ARTIFACT_BINDING");
  const outputs = new Map<WorkflowOperationName, unknown>();
  try {
    for (const name of order) {
      if (name === "register-exploration-charter") {
        if (!input.charter) throw new QaSkillsError("Exploratory workflow requires exactly one charter", "INVALID_ARTIFACT");
        outputs.set(name, await registerCharter(workspace, input.charter));
        continue;
      }
      if (name === "select-regression") {
        if (!input.regression) throw new QaSkillsError("Regression workflow requires a declared change scope", "ARTIFACT_BINDING");
        const selection = selectRegressionCases(input.regression);
        outputs.set(name, await registerSelection(workspace, selection));
        continue;
      }
      if (name === "execute-browser-test") await assertApprovedCanonicalRevisions(workspace, input.approvedRevisionArtifactIds);
      if (name === "derive-retest-verdict") {
        if (!input.retest) throw new QaSkillsError("Retest workflow requires a source bug and reproduction", "ARTIFACT_BINDING");
        outputs.set(name, await registerRetestResult(workspace, input.retest));
        continue;
      }
      const operation = registry[name];
      if (!operation) throw new QaSkillsError(`Workflow operation ${name} requires its typed runtime input`, "ARTIFACT_BINDING");
      outputs.set(name, await operation({ name, workspace, input, outputs }));
      if (name === "reproduce-bug") {
        if (!input.retest) throw new QaSkillsError("Retest workflow requires a source bug and reproduction", "ARTIFACT_BINDING");
        await exactRetestReproduction(workspace, input.retest);
      }
    }
    const validation = await workspace.finalize(input.mode);
    return { runId: workspace.runId, mode: input.mode, operationOrder: order, outputs, validation };
  } finally { if (ownsWorkspace) await workspace.close(); }
}
