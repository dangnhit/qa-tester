import { assertExplorationCharter, type ExplorationCharter } from "../exploratory/charter.js";
import { deriveRetestVerdict, type RegressionOutcome } from "../retest/verdict.js";
import { selectRegressionCases, type RegressionSelection } from "../regression/selector.js";
import type { ChangeScope, RegressionCase } from "../regression/change-scope.js";
import { QaSkillsError } from "../core/errors.js";
import { RunWorkspace, type ArtifactRecord, type WorkspaceValidation } from "../core/run-workspace.js";
import { operationsForMode, type PublicWorkflowMode, type WorkflowOperationName } from "../orchestration/modes.js";
import type { Browser } from "@playwright/test";
import type { SecretResolver } from "../browser/types.js";
import { executeTestInstance } from "./execute-browser-test.js";
import { attachEvidence, captureEvidence } from "../evidence/collector.js";
import { resolveEvidencePolicy, type EvidencePolicyLayers } from "../evidence/policy.js";
import { prepareTestData } from "./prepare-test-data.js";
import { TestDataHookRegistry } from "../test-data/hooks.js";
import { registerChangeScope } from "../regression/change-scope.js";
import { evaluateWorkspaceCoverage } from "./evaluate-workspace-coverage.js";
import { deriveTestPlanApproval } from "../planning/approval.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
  regression?: Readonly<{ changes: readonly ChangeScope[]; testCases: readonly RegressionCase[]; sourceRunId?: string }>;
  retest?: Readonly<{ sourceBugArtifactId: string; reproductionAttemptIds: readonly string[]; regressionOutcome?: RegressionOutcome }>;
}>;
export type WorkflowResult = Readonly<{ runId: string; mode: PublicWorkflowMode; operationOrder: readonly WorkflowOperationName[]; outputs: ReadonlyMap<WorkflowOperationName, unknown>; validation: WorkspaceValidation }>;

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
  linkedRunId?: string;
  runtime?: Readonly<{ browserManagerId?: string; secretResolverId?: string; testDataRegistryId?: string; evidencePolicyId?: string; changeScopeSourceId?: string }>;
  charter?: ExplorationCharter;
  retest?: Readonly<{ sourceBug: RegisteredArtifactRef }>;
}>;

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new QaSkillsError(`Registered ${label} is invalid`, "ARTIFACT_BINDING");
  return value;
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
    const classification = environment?.classification;
    if (typeof classification !== "string") throw new QaSkillsError("Import target has no valid environment", "ARTIFACT_BINDING");
    const copy = async (type: "requirement-analysis" | "test-plan" | "test-case" | "coverage-obligation", item: (typeof selected)[number]): Promise<void> => {
      const value = JSON.parse(JSON.stringify(item.value)) as Record<string, unknown>;
      if (type === "coverage-obligation") {
        const sourceAnalysis = asString(value.requirementAnalysisArtifactId, "coverage obligation requirement analysis ID");
        const localAnalysis = imported.get(sourceAnalysis);
        if (!localAnalysis) throw new QaSkillsError("Canonical coverage obligation precedes its requirement analysis", "ARTIFACT_BINDING");
        value.requirementAnalysisArtifactId = localAnalysis.id;
      }
      if (type === "test-plan") {
        const analyses = (await workspace.readRegisteredArtifacts()).filter((artifact) => artifact.record.type === "requirement-analysis").map((artifact) => artifact.value);
        value.approvalDecision = deriveTestPlanApproval({ plan: value, requirementAnalyses: analyses, environment: { classification: classification as "local" | "test" | "staging" | "production" } });
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

async function executeWithRuntime(workspace: RunWorkspace, runtime: QaRuntimeRegistry, ids: NonNullable<QaWorkflowInput["runtime"]>, caseArtifactIds: readonly string[]): Promise<readonly string[]> {
  const manager = resolveRuntime(runtime.browserManagers, ids.browserManagerId, "browser manager");
  const resolver = ids.secretResolverId === undefined ? undefined : resolveRuntime(runtime.secretResolvers, ids.secretResolverId, "secret resolver");
  const policy = resolveEvidencePolicy(ids.evidencePolicyId === undefined ? {} : resolveRuntime(runtime.evidencePolicies, ids.evidencePolicyId, "evidence policy"));
  const evidenceIds: string[] = [];
  for (const [index, testCaseArtifactId] of caseArtifactIds.entries()) {
    const artifacts = await workspace.readRegisteredArtifacts();
    const testCase = artifacts.find((artifact) => artifact.record.id === testCaseArtifactId && artifact.record.type === "test-case");
    if (!testCase) throw new QaSkillsError("Runtime execution case is not registered", "ARTIFACT_BINDING");
    const attemptId = `ATT-${workspace.runId}-${index + 1}`;
    await executeTestInstance({ workspace, browser: manager.browser, attemptId, testCaseArtifactId, ...(resolver === undefined ? {} : { resolveSecret: resolver }), onSessionActive: async () => {
      const attachment = async (telemetry: "console" | "network" | "log") => {
        const evidence = await attachEvidence({ workspace, attemptId, callerAttemptId: attemptId, telemetry, testcaseId: asString(testCase.value.testCaseId, "test case ID") });
        if (evidence.kind === "evidence") evidenceIds.push(evidence.descriptorArtifactId);
        else evidenceIds.push(evidence.descriptorArtifactId);
      };
      if (policy.logs !== "forbidden" && policy.logs !== "off") await attachment("log");
      if (policy.console !== "forbidden" && policy.console !== "off") await attachment("console");
      if (policy.network !== "forbidden" && policy.network !== "off") await attachment("network");
      if (policy.screenshot === "always" || policy.screenshot === "required") {
        const evidence = await captureEvidence({ workspace, attemptId, callerAttemptId: attemptId, protectedEnvironment: false, redaction: { domSelectors: [], regions: [] }, testcaseId: asString(testCase.value.testCaseId, "test case ID") });
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
  const statuses = regression.map((attempt) => String(attempt.value.status));
  const regressionOutcome: RegressionOutcome = statuses.length === 0 ? "NOT_RUN" : statuses.includes("FAILED") ? "FAILED" : statuses.includes("BLOCKED") ? "BLOCKED" : statuses.includes("INCONCLUSIVE") ? "INCONCLUSIVE" : statuses.every((status) => status === "PASSED") ? "PASSED" : "NOT_RUN";
  const verdict = deriveRetestVerdict({ originalBugId: source.bugId, reproductionStatuses: reproduction.map((attempt) => String(attempt?.value.status)), regressionOutcome });
  return workspace.registerArtifactValue({ type: "retest-result", value: { artifactType: "retest-result", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: workspace.runId, sourceRunId: workspace.linkedRunId, sourceBugArtifactId: reference.artifactId, sourceBugArtifactSha256: reference.sha256, bugId: source.bugId, reproductionAttemptIds: [...reproductionAttemptIds], verdict: verdict.verdict, regressionOutcome }, relationships: reproduction.map((attempt) => attempt?.record.id).filter((id): id is string => id !== undefined), provenance: "runtime" });
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

async function registerSelection(workspace: RunWorkspace, selection: RegressionSelection): Promise<ArtifactRecord> {
  const artifacts = await workspace.readRegisteredArtifacts();
  const decisions = [...selection.selected, ...selection.excluded];
  const relationships = decisions.map((decision) => artifacts.filter((artifact) => artifact.record.type === "test-case" && artifact.value.testCaseId === decision.testCaseId && artifact.value.revisionId === decision.revisionId)).flat();
  if (relationships.length !== decisions.length) throw new QaSkillsError("Regression selection requires every decision to bind one registered canonical test case revision", "ARTIFACT_BINDING");
  return workspace.registerArtifactValue({ type: "regression-selection", value: {
    artifactType: "regression-selection", schemaVersion: "1.0.0", producerVersion: "0.1.0", selectionId: `REG-${workspace.runId}`, runId: workspace.runId, ...selection,
  }, relationships: relationships.map((artifact) => artifact.record.id), provenance: "runtime" });
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
    sourceBugArtifactId: input.sourceBugArtifactId, sourceBugArtifactSha256: reproduction.source.record.sha256, bugId: verdict.bugId, reproductionAttemptIds: [...input.reproductionAttemptIds], verdict: verdict.verdict,
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

/**
 * Constructs the production QA Tester around a closed, typed host registry.
 * This is deliberately separate from createWorkflowRunner, whose callback
 * registry is a test seam and is not exported through a Skill Adapter.
 */
export function createQaTester(runtime: QaRuntimeRegistry): (input: QaWorkflowInput) => Promise<WorkflowResult> {
  return async (input) => {
    const ownsWorkspace = true;
    const workspace = await RunWorkspace.create({ root: input.root, mode: input.mode, environmentProfile: input.environmentProfile, ...(input.linkedRunId === undefined ? {} : { linkedRunId: input.linkedRunId }) });
    const outputs = new Map<WorkflowOperationName, unknown>();
    const order = operationsForMode(input.mode);
    try {
      // Validate all runtime service IDs before any irreversible operation.  A
      // missing service leaves this created workspace resumable/nonterminal.
      if (["full", "execute", "regression", "retest"].includes(input.mode)) resolveRuntime(runtime.browserManagers, input.runtime?.browserManagerId, "browser manager");
      if (["full", "execute", "regression", "retest"].includes(input.mode)) {
        if (!input.bundle) throw new QaSkillsError("Workflow requires a checksum-bound canonical plan bundle", "ARTIFACT_BINDING");
        await importCanonicalPlanBundle(workspace, input.bundle);
      }
      if (input.mode === "exploratory") {
        if (!input.charter) throw new QaSkillsError("Exploratory workflow requires exactly one charter", "INVALID_ARTIFACT");
        outputs.set("register-exploration-charter", await registerCharter(workspace, input.charter));
        throw new QaSkillsError("Exploration requires a runtime-owned evidence operation", "ARTIFACT_BINDING");
      }
      if (input.mode === "plan") {
        if (!input.bundle) throw new QaSkillsError("Plan workflow requires a canonical bundle materialized by the runtime", "ARTIFACT_BINDING");
        await importCanonicalPlanBundle(workspace, input.bundle);
      }
      if (input.mode === "full") {
        const hooks = resolveRuntime(runtime.testDataRegistries, input.runtime?.testDataRegistryId, "test-data registry");
        outputs.set("prepare-test-data", await prepareTestData({ workspace, hooks, hookIds: [] }));
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
        await executeWithRuntime(workspace, runtime, input.runtime ?? {}, [exact.record.id]);
        reproductionAttempts = (await workspace.readRegisteredArtifacts()).filter((artifact) => artifact.record.type === "test-result" && artifact.value.testCaseId === source.testCaseId && artifact.value.testCaseRevisionId === source.revisionId && artifact.value.testCaseInstanceId === source.instanceId).map((artifact) => asString(artifact.value.attemptId, "reproduction attempt ID"));
        outputs.set("reproduce-bug", reproductionAttempts);
        const changeSource = resolveRuntime(runtime.changeScopeSources, input.runtime?.changeScopeSourceId, "change-scope source");
        await registerChangeScope({ workspace, changes: changeSource.changes, provenance: changeSource.provenance });
        const selectedArtifacts = await workspace.readRegisteredArtifacts();
        const selection = selectRegressionCases({ changes: changeSource.changes, testCases: selectedArtifacts.filter((artifact) => artifact.record.type === "test-case").map((artifact) => ({
          testCaseId: asString(artifact.value.testCaseId, "test case ID"), revisionId: asString(artifact.value.revisionId, "test case revision ID"),
          requirementIds: record(artifact.value.coverage) && typeof artifact.value.coverage.requirementId === "string" ? [artifact.value.coverage.requirementId] : [], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [],
        })) });
        const registeredSelection = await registerSelection(workspace, selection);
        outputs.set("select-regression", registeredSelection);
        executionCases = registeredSelection.relationships.filter((id) => id !== exact.record.id);
      }
      if (input.mode === "regression") {
        const source = resolveRuntime(runtime.changeScopeSources, input.runtime?.changeScopeSourceId, "change-scope source");
        const change = await registerChangeScope({ workspace, changes: source.changes, provenance: source.provenance });
        const artifacts = await workspace.readRegisteredArtifacts();
        const testCases: RegressionCase[] = artifacts.filter((artifact) => artifact.record.type === "test-case").map((artifact) => ({
          testCaseId: asString(artifact.value.testCaseId, "test case ID"), revisionId: asString(artifact.value.revisionId, "test case revision ID"),
          requirementIds: record(artifact.value.coverage) && typeof artifact.value.coverage.requirementId === "string" ? [artifact.value.coverage.requirementId] : [], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [],
        }));
        const selection = selectRegressionCases({ changes: source.changes, testCases });
        const registered = await registerSelection(workspace, selection);
        outputs.set("select-regression", registered);
        outputs.set("ingest-requirement-analysis", change);
        executionCases = registered.relationships.filter((id) => artifacts.some((artifact) => artifact.record.id === id && artifact.record.type === "test-case"));
      }
      if (["full", "execute", "regression"].includes(input.mode)) {
        if (executionCases.length === 0) throw new QaSkillsError("Runtime execution requires imported approved canonical test cases", "ARTIFACT_BINDING");
        outputs.set("execute-browser-test", await executeWithRuntime(workspace, runtime, input.runtime ?? {}, executionCases));
        if (input.mode === "full") {
          const attempts = await workspace.readRegisteredArtifacts();
          for (const attempt of attempts.filter((artifact) => artifact.record.type === "test-result" && artifact.value.status === "FAILED")) {
            // This operation derives eligibility from registered attempt/evidence;
            // it never accepts a caller-authored result or diagnosis.
            const generated = await (await import("./generate-bug-report.js")).generateBugReport({ workspace, attemptId: asString(attempt.value.attemptId, "attempt ID") });
            outputs.set("generate-bug-report", generated);
          }
          outputs.set("ingest-coverage-obligation", await evaluateWorkspaceCoverage({ root: workspace.root, runId: workspace.runId }));
        }
        if (input.mode === "full" || input.mode === "regression") outputs.set("generate-qa-report", await (await import("./generate-qa-report.js")).generateQaReport({ workspace }));
      }
      if (input.mode === "retest") {
        if (!retestSource || !input.retest) throw new QaSkillsError("Retest source was not resolved", "ARTIFACT_BINDING");
        // The remaining imported cases are regression work and remain
        // independent from the source-bug verdict.
        const regressionEvidence = executionCases.length === 0 ? [] : await executeWithRuntime(workspace, runtime, input.runtime ?? {}, executionCases);
        outputs.set("collect-evidence", regressionEvidence);
        const all = await workspace.readRegisteredArtifacts();
        const reproductionIds = new Set(reproductionAttempts);
        const regressionAttemptIds = all.filter((artifact) => artifact.record.type === "test-result" && !reproductionIds.has(String(artifact.value.attemptId))).map((artifact) => asString(artifact.value.attemptId, "regression attempt ID"));
        outputs.set("derive-retest-verdict", await registerRuntimeRetestResult(workspace, input.retest.sourceBug, retestSource, reproductionAttempts, regressionAttemptIds));
      }
      const validation = await workspace.finalize(input.mode);
      return { runId: workspace.runId, mode: input.mode, operationOrder: order, outputs, validation };
    } finally { if (ownsWorkspace) await workspace.close(); }
  };
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
        if (input.regression.sourceRunId) await importRegressionCases(workspace, input.regression.sourceRunId);
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
