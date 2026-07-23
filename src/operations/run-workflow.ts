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
import { attachEvidence, captureEvidence } from "../evidence/collector.js";
import { resolveEvidencePolicy, type EvidencePolicyLayers } from "../evidence/policy.js";
import { prepareTestData } from "./prepare-test-data.js";
import { TestDataHookRegistry } from "../test-data/hooks.js";
import { registerChangeScope } from "../regression/change-scope.js";
import { evaluateWorkspaceCoverage } from "./evaluate-workspace-coverage.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createEntityId } from "../core/ids.js";

/** Outputs are canonical artifacts, typed operation summaries, IDs, or no value; callers never receive `unknown`. */
export type WorkflowOutput = ArtifactRecord | readonly string[] | object | void;
export type WorkflowOperation = (context: Readonly<{ name: WorkflowOperationName; workspace: RunWorkspace; input: WorkflowInput; outputs: ReadonlyMap<WorkflowOperationName, WorkflowOutput> }>) => Promise<WorkflowOutput>;
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
export type WorkflowResult = Readonly<{ runId: string; mode: PublicWorkflowMode; outcome: "AWAITING_RUNTIME" | "COMPLETED"; operationOrder: readonly WorkflowOperationName[]; outputs: ReadonlyMap<WorkflowOperationName, WorkflowOutput>; validation: WorkspaceValidation }>;

/** A checksum-bound immutable source record.  Public workflows never accept a raw draft. */
export type RegisteredArtifactRef = Readonly<{ artifactId: string; sha256: string }>;
export type CanonicalPlanBundleRef = Readonly<{ sourceRunId: string; artifacts: readonly RegisteredArtifactRef[] }>;
export type QaRuntimeRegistry = Readonly<{
  browserManagers?: Readonly<Record<string, Readonly<{ browser: Browser }>>>;
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
  runtime?: Readonly<{ browserManagerId?: string; secretResolverId?: string; testDataRegistryId?: string; evidencePolicyId?: string; changeScopeSourceId?: string }>;
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
  return sha256Text(JSON.stringify({ mode: input.mode, environmentProfile: input.environmentProfile, bundle: input.bundle, linkedRunId: input.linkedRunId, charter: input.charter, retest: input.retest }));
}

type WorkflowCheckpoint = Readonly<{ record: ArtifactRecord; completedOperations: readonly WorkflowOperationName[]; operationOutputs: Readonly<Record<string, readonly RegisteredArtifactRef[]>> }>;

async function checkpointWorkflow(workspace: RunWorkspace, input: QaWorkflowInput): Promise<WorkflowCheckpoint> {
  const checkpoints = (await workspace.readRegisteredArtifacts()).filter((artifact) => artifact.record.type === "workflow-checkpoint");
  const checksum = workflowInputChecksum(input);
  if (checkpoints.length > 0) {
    const latest = [...checkpoints].sort((left, right) => Number(right.value.revision) - Number(left.value.revision))[0];
    if (!latest || latest.value.inputChecksum !== checksum) throw new QaSkillsError("Resume input does not match its durable workflow checkpoint", "ARTIFACT_BINDING");
    return { record: latest.record, completedOperations: Array.isArray(latest.value.completedOperations) ? latest.value.completedOperations as WorkflowOperationName[] : [], operationOutputs: record(latest.value.operationOutputs) ? latest.value.operationOutputs as Record<string, readonly RegisteredArtifactRef[]> : {} };
  }
  const created = await workspace.registerArtifactValue({ type: "workflow-checkpoint", value: {
    artifactType: "workflow-checkpoint", schemaVersion: "1.0.0", producerVersion: "0.1.0", checkpointId: `CHK-${workspace.runId}`, runId: workspace.runId, mode: input.mode,
    inputChecksum: checksum, revision: 1, completedOperations: [], operationOutputs: {}, ...(input.bundle === undefined ? {} : { bundle: { sourceRunId: input.bundle.sourceRunId, artifacts: input.bundle.artifacts.map((artifact) => ({ artifactId: artifact.artifactId, sha256: artifact.sha256 })) } }),
  }, relationships: [], provenance: "runtime" });
  return { record: created, completedOperations: [], operationOutputs: {} };
}

async function advanceCheckpoint(workspace: RunWorkspace, input: QaWorkflowInput, previous: WorkflowCheckpoint, operation: WorkflowOperationName, output: WorkflowOutput | readonly ArtifactRecord[]): Promise<WorkflowCheckpoint> {
  if (previous.completedOperations.includes(operation)) return previous;
  const records: readonly ArtifactRecord[] = Array.isArray(output) ? output.filter(artifactRecord) : artifactRecord(output) ? [output] : [];
  const operationOutputs: Record<string, readonly RegisteredArtifactRef[]> = { ...previous.operationOutputs, [operation]: records.map((artifact) => ({ artifactId: artifact.id, sha256: artifact.sha256 })) };
  const registered = await workspace.registerArtifactValue({ type: "workflow-checkpoint", value: {
    artifactType: "workflow-checkpoint", schemaVersion: "1.0.0", producerVersion: "0.1.0", checkpointId: `CHK-${workspace.runId}`, runId: workspace.runId, mode: input.mode, inputChecksum: workflowInputChecksum(input), revision: Number((await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.id === previous.record.id)?.value.revision) + 1,
    supersedesArtifactId: previous.record.id, completedOperations: [...previous.completedOperations, operation], operationOutputs,
    ...(input.bundle === undefined ? {} : { bundle: { sourceRunId: input.bundle.sourceRunId, artifacts: input.bundle.artifacts.map((artifact) => ({ artifactId: artifact.artifactId, sha256: artifact.sha256 })) } }),
  }, relationships: [previous.record.id, ...records.map((artifact) => artifact.id)], provenance: "runtime" });
  return { record: registered, completedOperations: [...previous.completedOperations, operation], operationOutputs };
}

async function newArtifactsSince(workspace: RunWorkspace, before: ReadonlySet<string>): Promise<readonly ArtifactRecord[]> {
  return (await workspace.readRegisteredArtifacts()).filter((artifact) => !before.has(artifact.record.id)).map((artifact) => artifact.record);
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

async function executeWithRuntime(workspace: RunWorkspace, runtime: QaRuntimeRegistry, ids: NonNullable<QaWorkflowInput["runtime"]>, caseArtifactIds: readonly string[]): Promise<readonly string[]> {
  const manager = resolveRuntime(runtime.browserManagers, ids.browserManagerId, "browser manager");
  const resolver = ids.secretResolverId === undefined ? undefined : resolveRuntime(runtime.secretResolvers, ids.secretResolverId, "secret resolver");
  const policy = resolveEvidencePolicy(ids.evidencePolicyId === undefined ? {} : resolveRuntime(runtime.evidencePolicies, ids.evidencePolicyId, "evidence policy"));
  const policyLayers = ids.evidencePolicyId === undefined ? {} : resolveRuntime(runtime.evidencePolicies, ids.evidencePolicyId, "evidence policy");
  const environment = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "environment-profile")?.value;
  if (!record(environment)) throw new QaSkillsError("Runtime execution requires a registered environment profile", "ARTIFACT_BINDING");
  const capturePolicy = capturePolicyForEnvironment(environment, policyLayers);
  const evidenceIds: string[] = [];
  for (const testCaseArtifactId of caseArtifactIds) {
    const artifacts = await workspace.readRegisteredArtifacts();
    const testCase = artifacts.find((artifact) => artifact.record.id === testCaseArtifactId && artifact.record.type === "test-case");
    if (!testCase) throw new QaSkillsError("Runtime execution case is not registered", "ARTIFACT_BINDING");
    const attemptId = `ATT-${workspace.runId}-${createEntityId()}`;
    await executeTestInstance({ workspace, browser: manager.browser, attemptId, testCaseArtifactId, ...(resolver === undefined ? {} : { resolveSecret: resolver }), onBeforeSessionClose: async ({ attempt }) => {
      const attachment = async (telemetry: "console" | "network" | "log") => {
        const evidence = await attachEvidence({ workspace, attemptId, callerAttemptId: attemptId, telemetry, protectedEnvironment: capturePolicy.protectedEnvironment, testcaseId: asString(testCase.value.testCaseId, "test case ID") });
        if (evidence.kind === "evidence") evidenceIds.push(evidence.descriptorArtifactId);
        else evidenceIds.push(evidence.descriptorArtifactId);
      };
      if (policy.logs !== "forbidden" && policy.logs !== "off") await attachment("log");
      if (policy.console !== "forbidden" && policy.console !== "off") await attachment("console");
      if (policy.network !== "forbidden" && policy.network !== "off") await attachment("network");
      if (policy.screenshot === "always" || policy.screenshot === "required" || (policy.screenshot === "on-failure" && attempt.status !== "PASSED")) {
        const evidence = await captureEvidence({ workspace, attemptId, callerAttemptId: attemptId, protectedEnvironment: capturePolicy.protectedEnvironment, redaction: capturePolicy.redaction, testcaseId: asString(testCase.value.testCaseId, "test case ID") });
        evidenceIds.push(evidence.descriptorArtifactId);
      }
    } });
    const after = await workspace.readRegisteredArtifacts();
    const result = after.filter((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === attemptId);
    const evidence = after.filter((artifact) => (artifact.record.type === "evidence" || artifact.record.type === "evidence-gap") && artifact.value.attemptId === attemptId);
    if (result.length !== 1 || evidence.length === 0 || !evidence.every((artifact) => artifact.record.type === "evidence-gap" || (record(artifact.value.provenance) && artifact.value.provenance.testcaseId === testCase.value.testCaseId))) {
      throw new QaSkillsError("Runtime execution postcondition requires one result and case-bound evidence or evidence gap", "ARTIFACT_BINDING");
    }
  }
  return evidenceIds;
}

async function sourceBugFromReference(workspace: RunWorkspace, reference: RegisteredArtifactRef): Promise<Readonly<{ bugId: string; testCaseId: string; revisionId: string; instanceId: string }>> {
  if (!workspace.linkedRunId) throw new QaSkillsError("Retest requires a linked immutable source run", "ARTIFACT_BINDING");
  const source = await RunWorkspace.open(workspace.root, workspace.linkedRunId);
  try {
    const sourceRecord = await source.readArtifactRecord(reference.artifactId);
    if (sourceRecord.type !== "bug-report" || sourceRecord.sha256 !== reference.sha256) throw new QaSkillsError("Retest source bug reference checksum is invalid", "ARTIFACT_BINDING");
    const artifacts = await source.readRegisteredArtifacts();
    const bug = artifacts.find((artifact) => artifact.record.id === reference.artifactId && artifact.record.type === "bug-report");
    const attempt = bug === undefined ? undefined : artifacts.find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === bug.value.attemptId);
    if (!bug || !attempt) throw new QaSkillsError("Retest source bug lacks its immutable original attempt", "ARTIFACT_BINDING");
    return { bugId: asString(bug.value.bugId, "source bug ID"), testCaseId: asString(attempt.value.testCaseId, "source testcase ID"), revisionId: asString(attempt.value.testCaseRevisionId, "source testcase revision ID"), instanceId: asString(attempt.value.testCaseInstanceId, "source testcase instance ID") };
  } finally { await source.close(); }
}

async function registerRuntimeRetestResult(workspace: RunWorkspace, reference: RegisteredArtifactRef, source: Awaited<ReturnType<typeof sourceBugFromReference>>, reproductionAttemptIds: readonly string[], regressionAttemptIds: readonly string[]): Promise<ArtifactRecord> {
  const artifacts = await workspace.readRegisteredArtifacts();
  const reproduction = reproductionAttemptIds.map((attemptId) => artifacts.find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === attemptId));
  if (reproduction.length === 0 || reproduction.some((attempt) => !attempt || attempt.value.testCaseId !== source.testCaseId || attempt.value.testCaseRevisionId !== source.revisionId || attempt.value.testCaseInstanceId !== source.instanceId)) throw new QaSkillsError("Retest reproduction did not execute the exact immutable source testcase", "ARTIFACT_BINDING");
  const regression = regressionAttemptIds.map((attemptId) => artifacts.find((artifact) => artifact.record.type === "test-result" && artifact.value.attemptId === attemptId)).filter((attempt): attempt is NonNullable<typeof attempt> => attempt !== undefined);
  const regressionOutcome = deriveRegressionOutcome(regression.map((attempt) => asString(attempt.value.status, "regression execution status")));
  const reproductionScenarios = reproduction.map((attempt) => ({ scenarioId: sourceScenarioId({ testCaseId: source.testCaseId, revisionId: source.revisionId, instanceId: source.instanceId }), attemptId: asString(attempt?.value.attemptId, "reproduction attempt ID"), status: asString(attempt?.value.status, "reproduction execution status") }));
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
async function executeExploration(workspace: RunWorkspace, runtime: QaRuntimeRegistry, ids: NonNullable<QaWorkflowInput["runtime"]>, charter: ExplorationCharter): Promise<readonly string[]> {
  const manager = resolveRuntime(runtime.browserManagers, ids.browserManagerId, "browser manager");
  const environment = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "environment-profile")?.value;
  if (!record(environment) || typeof environment.baseUrl !== "string") throw new QaSkillsError("Exploration requires its registered environment", "ARTIFACT_BINDING");
  const policyLayers = ids.evidencePolicyId === undefined ? {} : resolveRuntime(runtime.evidencePolicies, ids.evidencePolicyId, "evidence policy");
  const capturePolicy = capturePolicyForEnvironment(environment, policyLayers);
  const attemptId = `EXP-${workspace.runId}-${createEntityId()}`;
  const session = await createBrowserAttemptSession(manager.browser, { testCaseId: `EXP-${charter.charterId}`, revisionId: charter.charterId, instanceId: charter.charterId });
  activeBrowserSessions.set(attemptId, session);
  try {
    // One bounded navigation is the only action this public charter executor
    // performs; the declared action budget is never exceeded.
    await session.page.goto(environment.baseUrl);
    const evidence = await captureEvidence({ workspace, attemptId, callerAttemptId: attemptId, protectedEnvironment: capturePolicy.protectedEnvironment, redaction: capturePolicy.redaction, testcaseId: `EXP-${charter.charterId}` });
    const charterRecord = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "exploration-charter");
    if (!charterRecord) throw new QaSkillsError("Exploration finding requires its registered charter", "ARTIFACT_BINDING");
    await workspace.registerArtifactValue({ type: "exploratory-finding", value: {
      artifactType: "exploratory-finding", schemaVersion: "1.0.0", producerVersion: "0.1.0", findingId: `EXP-FIND-${createEntityId()}`, runId: workspace.runId, charterId: charter.charterId,
      observation: `Bounded exploration reached ${environment.baseUrl} within the declared action budget.`, authority: "EXPLORATORY", satisfiesCoverage: false,
    }, relationships: [charterRecord.record.id, evidence.descriptorArtifactId], provenance: "runtime" });
    return [evidence.descriptorArtifactId];
  } finally {
    activeBrowserSessions.delete(attemptId);
    session.secrets.clear();
    await session.context.close();
  }
}

async function registerSelection(workspace: RunWorkspace, selection: RegressionSelection, changeScope: ArtifactRecord): Promise<ArtifactRecord> {
  const artifacts = await workspace.readRegisteredArtifacts();
  const decisions = [...selection.selected, ...selection.excluded];
  const relationships = decisions.map((decision) => artifacts.filter((artifact) => artifact.record.type === "test-case" && artifact.value.testCaseId === decision.testCaseId && artifact.value.revisionId === decision.revisionId)).flat();
  if (relationships.length !== decisions.length) throw new QaSkillsError("Regression selection requires every decision to bind one registered canonical test case revision", "ARTIFACT_BINDING");
  return workspace.registerArtifactValue({ type: "regression-selection", value: {
    artifactType: "regression-selection", schemaVersion: "1.0.0", producerVersion: "0.1.0", selectionId: `REG-${workspace.runId}`, runId: workspace.runId,
    changeScopeArtifactId: changeScope.id, changeScopeSha256: changeScope.sha256, decisionChecksum: sha256Text(JSON.stringify(selection)), ...selection,
  }, relationships: [changeScope.id, ...relationships.map((artifact) => artifact.record.id)], provenance: "runtime" });
}

function selectedCaseArtifactIds(selection: RegressionSelection, artifacts: readonly RegisteredWorkspaceArtifact[]): string[] {
  return selection.selected.flatMap((decision) => artifacts.filter((artifact) => artifact.record.type === "test-case" && artifact.value.testCaseId === decision.testCaseId && artifact.value.revisionId === decision.revisionId).map((artifact) => artifact.record.id));
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
  return async (input) => {
    const ownsWorkspace = true;
    const workspace = input.resumeRunId === undefined
      ? await RunWorkspace.create({ root: input.root, mode: input.mode, environmentProfile: input.environmentProfile, ...(input.linkedRunId === undefined ? {} : { linkedRunId: input.linkedRunId }) })
      : await RunWorkspace.open(input.root, input.resumeRunId);
    if (workspace.mode !== input.mode || workspace.linkedRunId !== input.linkedRunId) throw new QaSkillsError("Resume workspace does not match the requested immutable workflow identity", "ARTIFACT_BINDING");
    const outputs = new Map<WorkflowOperationName, WorkflowOutput>();
    const order = operationsForMode(input.mode);
    try {
      let checkpoint = await checkpointWorkflow(workspace, input);
      const missing = missingRuntimeLabel(runtime, input);
      if (missing !== undefined) return { runId: workspace.runId, mode: input.mode, outcome: "AWAITING_RUNTIME", operationOrder: order, outputs, validation: await workspace.validate(input.mode) };
      // Every required source/runtime dependency is resolved before any
      // import, data preparation, browser action, or report side effect.
      if (input.mode === "retest") {
        if (!input.retest) throw new QaSkillsError("Retest requires a checksum-bound source bug reference", "ARTIFACT_BINDING");
        resolveRuntime(runtime.changeScopeSources, input.runtime?.changeScopeSourceId, "change-scope source");
        await sourceBugFromReference(workspace, input.retest.sourceBug);
      }
      if (["full", "execute", "regression", "retest", "exploratory"].includes(input.mode)) resolveRuntime(runtime.browserManagers, input.runtime?.browserManagerId, "browser manager");
      if (["full", "execute", "regression", "retest"].includes(input.mode)) {
        if (!input.bundle) throw new QaSkillsError("Workflow requires a checksum-bound canonical plan bundle", "ARTIFACT_BINDING");
        if (!(await workspace.readRegisteredArtifacts()).some((artifact) => artifact.record.type === "test-case")) {
          const before = new Set((await workspace.readRegisteredArtifacts()).map((artifact) => artifact.record.id));
          await importCanonicalPlanBundle(workspace, input.bundle);
          checkpoint = await advanceCheckpoint(workspace, input, checkpoint, "ingest-testcases", await newArtifactsSince(workspace, before));
        }
      }
      if (input.mode === "exploratory") {
        if (!input.charter) throw new QaSkillsError("Exploratory workflow requires exactly one charter", "INVALID_ARTIFACT");
        if (!checkpoint.completedOperations.includes("register-exploration-charter")) {
          const before = new Set((await workspace.readRegisteredArtifacts()).map((artifact) => artifact.record.id));
          outputs.set("register-exploration-charter", await registerCharter(workspace, input.charter));
          checkpoint = await advanceCheckpoint(workspace, input, checkpoint, "register-exploration-charter", await newArtifactsSince(workspace, before));
        }
        if (!checkpoint.completedOperations.includes("collect-evidence")) {
          const before = new Set((await workspace.readRegisteredArtifacts()).map((artifact) => artifact.record.id));
          outputs.set("collect-evidence", await executeExploration(workspace, runtime, input.runtime ?? {}, input.charter));
          checkpoint = await advanceCheckpoint(workspace, input, checkpoint, "collect-evidence", await newArtifactsSince(workspace, before));
        }
        if (!checkpoint.completedOperations.includes("generate-qa-report")) {
          const before = new Set((await workspace.readRegisteredArtifacts()).map((artifact) => artifact.record.id));
          outputs.set("generate-qa-report", await (await import("./generate-qa-report.js")).generateQaReport({ workspace }));
          checkpoint = await advanceCheckpoint(workspace, input, checkpoint, "generate-qa-report", await newArtifactsSince(workspace, before));
        }
        const validation = await workspace.finalize(input.mode);
        return { runId: workspace.runId, mode: input.mode, outcome: "COMPLETED", operationOrder: order, outputs, validation };
      }
      if (input.mode === "plan") {
        if (!input.bundle) throw new QaSkillsError("Plan workflow requires a canonical bundle materialized by the runtime", "ARTIFACT_BINDING");
        if (!(await workspace.readRegisteredArtifacts()).some((artifact) => artifact.record.type === "test-case")) {
          const before = new Set((await workspace.readRegisteredArtifacts()).map((artifact) => artifact.record.id));
          await importCanonicalPlanBundle(workspace, input.bundle);
          checkpoint = await advanceCheckpoint(workspace, input, checkpoint, "ingest-testcases", await newArtifactsSince(workspace, before));
        }
      }
      if (input.mode === "full") {
        const hooks = resolveRuntime(runtime.testDataRegistries, input.runtime?.testDataRegistryId, "test-data registry");
        if (!checkpoint.completedOperations.includes("prepare-test-data")) {
          const before = new Set((await workspace.readRegisteredArtifacts()).map((artifact) => artifact.record.id));
          outputs.set("prepare-test-data", await prepareTestData({ workspace, hooks, hookIds: [] }));
          checkpoint = await advanceCheckpoint(workspace, input, checkpoint, "prepare-test-data", await newArtifactsSince(workspace, before));
        }
      }
      let executionCases = (await workspace.readRegisteredArtifacts()).filter((artifact) => artifact.record.type === "test-case").map((artifact) => artifact.record.id);
      let retestSource: Awaited<ReturnType<typeof sourceBugFromReference>> | undefined;
      let reproductionAttempts: readonly string[] = [];
      if (input.mode === "retest") {
        if (!input.retest) throw new QaSkillsError("Retest requires a checksum-bound source bug reference", "ARTIFACT_BINDING");
        const source = await sourceBugFromReference(workspace, input.retest.sourceBug);
        retestSource = source;
        const artifacts = await workspace.readRegisteredArtifacts();
        const exact = artifacts.find((artifact) => artifact.record.type === "test-case" && artifact.value.testCaseId === source.testCaseId && artifact.value.revisionId === source.revisionId && artifact.value.instanceId === source.instanceId);
        if (!exact) throw new QaSkillsError("Retest bundle must import the exact original testcase revision and instance", "ARTIFACT_BINDING");
        // Reproduction is an actual runtime execution before regression
        // selection, never a caller-provided attempt ID or outcome claim.
        if (!checkpoint.completedOperations.includes("reproduce-bug")) {
          const before = new Set((await workspace.readRegisteredArtifacts()).map((artifact) => artifact.record.id));
          await executeWithRuntime(workspace, runtime, input.runtime ?? {}, [exact.record.id]);
          checkpoint = await advanceCheckpoint(workspace, input, checkpoint, "reproduce-bug", await newArtifactsSince(workspace, before));
        }
        reproductionAttempts = (await workspace.readRegisteredArtifacts()).filter((artifact) => artifact.record.type === "test-result" && artifact.value.testCaseId === source.testCaseId && artifact.value.testCaseRevisionId === source.revisionId && artifact.value.testCaseInstanceId === source.instanceId).map((artifact) => asString(artifact.value.attemptId, "reproduction attempt ID"));
        outputs.set("reproduce-bug", reproductionAttempts);
        const changeSource = resolveRuntime(runtime.changeScopeSources, input.runtime?.changeScopeSourceId, "change-scope source");
        if (!(await workspace.readRegisteredArtifacts()).some((artifact) => artifact.record.type === "change-scope")) await registerChangeScope({ workspace, changes: changeSource.changes, provenance: changeSource.provenance });
        const selectedArtifacts = await workspace.readRegisteredArtifacts();
        const scope = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "change-scope");
        if (!scope) throw new QaSkillsError("Retest change scope was not registered", "ARTIFACT_BINDING");
        const selection = selectRegressionCases({ changes: changeSource.changes, testCases: selectedArtifacts.filter((artifact) => artifact.record.type === "test-case").map((artifact) => regressionCaseFromCanonical(artifact.value)) });
        if (!checkpoint.completedOperations.includes("select-regression")) {
          const before = new Set((await workspace.readRegisteredArtifacts()).map((artifact) => artifact.record.id));
          const registeredSelection = await registerSelection(workspace, selection, scope.record);
          outputs.set("select-regression", registeredSelection);
          checkpoint = await advanceCheckpoint(workspace, input, checkpoint, "select-regression", await newArtifactsSince(workspace, before));
        }
        const selectionArtifacts = await workspace.readRegisteredArtifacts();
        executionCases = selectedCaseArtifactIds(selection, selectionArtifacts).filter((id) => id !== exact.record.id);
      }
      if (input.mode === "regression") {
        const source = resolveRuntime(runtime.changeScopeSources, input.runtime?.changeScopeSourceId, "change-scope source");
        const change = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "change-scope")?.record ?? await registerChangeScope({ workspace, changes: source.changes, provenance: source.provenance });
        const artifacts = await workspace.readRegisteredArtifacts();
        const testCases: RegressionCase[] = artifacts.filter((artifact) => artifact.record.type === "test-case").map((artifact) => regressionCaseFromCanonical(artifact.value));
        const selection = selectRegressionCases({ changes: source.changes, testCases });
        if (!checkpoint.completedOperations.includes("select-regression")) {
          const before = new Set((await workspace.readRegisteredArtifacts()).map((artifact) => artifact.record.id));
          const registered = await registerSelection(workspace, selection, change);
          outputs.set("select-regression", registered);
          checkpoint = await advanceCheckpoint(workspace, input, checkpoint, "select-regression", await newArtifactsSince(workspace, before));
        }
        executionCases = selectedCaseArtifactIds(selection, artifacts);
      }
      if (["full", "execute", "regression"].includes(input.mode)) {
        if (executionCases.length === 0) throw new QaSkillsError("Runtime execution requires imported approved canonical test cases", "ARTIFACT_BINDING");
        if (!checkpoint.completedOperations.includes("execute-browser-test")) {
          const before = new Set((await workspace.readRegisteredArtifacts()).map((artifact) => artifact.record.id));
          outputs.set("execute-browser-test", await executeWithRuntime(workspace, runtime, input.runtime ?? {}, executionCases));
          checkpoint = await advanceCheckpoint(workspace, input, checkpoint, "execute-browser-test", await newArtifactsSince(workspace, before));
        }
        if (input.mode === "full") {
          const attempts = await workspace.readRegisteredArtifacts();
          for (const attempt of attempts.filter((artifact) => artifact.record.type === "test-result" && artifact.value.status === "FAILED")) {
            // This operation derives eligibility from registered attempt/evidence;
            // it never accepts a caller-authored result or diagnosis.
            const generated = await (await import("./generate-bug-report.js")).generateBugReport({ workspace, attemptId: asString(attempt.value.attemptId, "attempt ID") });
            outputs.set("generate-bug-report", generated);
          }
          if (!checkpoint.completedOperations.includes("ingest-coverage-obligation")) {
            const before = new Set((await workspace.readRegisteredArtifacts()).map((artifact) => artifact.record.id));
            outputs.set("ingest-coverage-obligation", await evaluateWorkspaceCoverage({ root: workspace.root, runId: workspace.runId, workspace }));
            checkpoint = await advanceCheckpoint(workspace, input, checkpoint, "ingest-coverage-obligation", await newArtifactsSince(workspace, before));
          }
        }
        if ((input.mode === "full" || input.mode === "regression") && !checkpoint.completedOperations.includes("generate-qa-report")) {
          const before = new Set((await workspace.readRegisteredArtifacts()).map((artifact) => artifact.record.id));
          outputs.set("generate-qa-report", await (await import("./generate-qa-report.js")).generateQaReport({ workspace }));
          checkpoint = await advanceCheckpoint(workspace, input, checkpoint, "generate-qa-report", await newArtifactsSince(workspace, before));
        }
      }
      if (input.mode === "retest") {
        if (!retestSource || !input.retest) throw new QaSkillsError("Retest source was not resolved", "ARTIFACT_BINDING");
        // The remaining imported cases are regression work and remain
        // independent from the source-bug verdict.
        const regressionEvidence = checkpoint.completedOperations.includes("collect-evidence") || executionCases.length === 0 ? [] : await executeWithRuntime(workspace, runtime, input.runtime ?? {}, executionCases);
        outputs.set("collect-evidence", regressionEvidence);
        const all = await workspace.readRegisteredArtifacts();
        const reproductionIds = new Set(reproductionAttempts);
        const regressionAttemptIds = all.filter((artifact) => artifact.record.type === "test-result" && !reproductionIds.has(String(artifact.value.attemptId))).map((artifact) => asString(artifact.value.attemptId, "regression attempt ID"));
        if (!checkpoint.completedOperations.includes("derive-retest-verdict")) {
          const before = new Set((await workspace.readRegisteredArtifacts()).map((artifact) => artifact.record.id));
          outputs.set("derive-retest-verdict", await registerRuntimeRetestResult(workspace, input.retest.sourceBug, retestSource, reproductionAttempts, regressionAttemptIds));
          checkpoint = await advanceCheckpoint(workspace, input, checkpoint, "derive-retest-verdict", await newArtifactsSince(workspace, before));
        }
      }
      const validation = await workspace.finalize(input.mode);
      return { runId: workspace.runId, mode: input.mode, outcome: "COMPLETED", operationOrder: order, outputs, validation };
    } finally { if (ownsWorkspace) await workspace.close(); }
  };
}

async function runWorkflowWithRegistry(input: WorkflowInput, registry: WorkflowRegistry): Promise<WorkflowResult> {
  const order = operationsForMode(input.mode);
  if (input.mode === "retest" && !input.linkedRunId) throw new QaSkillsError("Retest creates a linked immutable run", "ARTIFACT_BINDING");
  if (input.mode === "regression" && !input.linkedRunId && input.retest !== undefined) throw new QaSkillsError("Retest regression must retain its linked source run", "ARTIFACT_BINDING");
  const ownsWorkspace = input.workspace === undefined;
  const workspace = input.workspace ?? await RunWorkspace.create({ root: input.root, mode: input.mode, environmentProfile: input.environmentProfile, ...(input.linkedRunId === undefined ? {} : { linkedRunId: input.linkedRunId }) });
  if (workspace.mode !== input.mode) throw new QaSkillsError("Workflow mode must match its runtime-owned workspace", "ARTIFACT_BINDING");
  if (input.linkedRunId !== undefined && workspace.linkedRunId !== input.linkedRunId) throw new QaSkillsError("Workflow linked source must match its runtime-owned workspace", "ARTIFACT_BINDING");
  const outputs = new Map<WorkflowOperationName, WorkflowOutput>();
  try {
    for (const name of order) {
      if (name === "register-exploration-charter") {
        if (!input.charter) throw new QaSkillsError("Exploratory workflow requires exactly one charter", "INVALID_ARTIFACT");
        outputs.set(name, await registerCharter(workspace, input.charter));
        continue;
      }
      if (name === "select-regression") {
        if (!input.regression) throw new QaSkillsError("Regression workflow requires a declared change scope", "ARTIFACT_BINDING");
        if (input.regression.sourceRunId) await importRegressionCases(workspace, input.regression.sourceRunId);
        const selection = selectRegressionCases(input.regression);
        const scope = await registerChangeScope({ workspace, changes: input.regression.changes, provenance: { kind: "declared-change", reference: "unsafe-test-seam" } });
        outputs.set(name, await registerSelection(workspace, selection, scope));
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
    return { runId: workspace.runId, mode: input.mode, outcome: "COMPLETED", operationOrder: order, outputs, validation };
  } finally { if (ownsWorkspace) await workspace.close(); }
}
