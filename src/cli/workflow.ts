import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { chromium } from "@playwright/test";

import { loadQaConfig } from "../config/load-config.js";
import type { ArtifactType } from "../contracts/types.js";
import { formatValidationErrors, validateArtifact } from "../contracts/validator.js";
import { publicWorkflowModes } from "../core/modes.js";
import { QaSkillsError } from "../core/errors.js";
import { isRecord } from "../core/values.js";
import { assertExplorationCharter } from "../exploratory/charter.js";
import { createQaTester, type QaWorkflowInput, type WorkflowResult } from "../orchestration/qa-tester.js";
import { TestDataHookRegistry } from "../test-data/hooks.js";
import { RunWorkspace } from "../core/run-workspace.js";
import { readAgentDraft } from "../operations/ingest-requirement-analysis.js";
import type { CanonicalPlanBundleRef } from "../operations/run-workflow.js";

export type ScaffoldOptions = Readonly<{
  root: string;
  mode: string;
  outputPath: string;
  environmentPath?: string;
  sourceRoot?: string;
  sourceRunId?: string;
  charterPath?: string;
  changeScopePath?: string;
  bugRunId?: string;
  bugArtifactId?: string;
  observedExecution?: boolean;
  resumeRunId?: string;
}>;
export type BootstrapOptions = Readonly<{ root: string; environmentPath: string; requirementPath: string; planPath: string; testCasePaths: readonly string[]; coveragePaths: readonly string[] }>;

/** Creates the first terminal planning run and returns its complete checksum-bound bundle. */
export async function bootstrapPlanningBundle(options: BootstrapOptions): Promise<{ runId: string; bundle: CanonicalPlanBundleRef }> {
  if (options.testCasePaths.length === 0 || options.coveragePaths.length === 0) throw new QaSkillsError("Bootstrap requires at least one testcase and coverage obligation", "INVALID_ARTIFACT");
  const environmentValue: unknown = JSON.parse(await readFile(resolve(options.environmentPath), "utf8"));
  if (!isRecord(environmentValue)) throw new QaSkillsError("Bootstrap environment profile must contain an object", "INVALID_ARTIFACT");
  const [requirement, plan, ...rest] = await Promise.all([
    readAgentDraft(resolve(options.requirementPath)),
    readAgentDraft(resolve(options.planPath)),
    ...options.testCasePaths.map((path) => readAgentDraft(resolve(path))),
    ...options.coveragePaths.map((path) => readAgentDraft(resolve(path))),
  ]);
  const testCases = rest.slice(0, options.testCasePaths.length);
  const obligations = rest.slice(options.testCasePaths.length);

  const preflight: readonly { path: string; type: ArtifactType; value: unknown }[] = [
    { path: options.requirementPath, type: "requirement-analysis", value: requirement },
    { path: options.planPath, type: "test-plan", value: plan },
    // `testCases`/`obligations` were sliced to exactly `testCasePaths`/`coveragePaths` length above, so each index is present.
    ...testCases.map((value, index) => ({ path: options.testCasePaths[index]!, type: "test-case" as const, value })),
    ...obligations.map((value, index) => ({ path: options.coveragePaths[index]!, type: "coverage-obligation" as const, value })),
  ];
  for (const entry of preflight) {
    const result = validateArtifact(entry.type, entry.value);
    if (!result.valid) {
      throw new QaSkillsError(`${resolve(entry.path)} does not satisfy the ${entry.type} contract: ${formatValidationErrors(result.errors)}`, "INVALID_ARTIFACT");
    }
  }

  const workspace = await RunWorkspace.create({ root: resolve(options.root), mode: "plan", environmentProfile: environmentValue });
  try {
    const batch = await workspace.registerArtifactValueBatch([
      { key: "requirement", type: "requirement-analysis", value: requirement, relationships: [], provenance: "agent-draft" },
      { key: "plan", type: "test-plan", value: plan, relationshipKeys: ["requirement"], provenance: "agent-draft" },
      ...testCases.map((value, index) => ({ key: `testcase-${index}`, type: "test-case" as const, value, relationshipKeys: ["plan"], provenance: "agent-draft" })),
      ...obligations.map((value, index) => ({ key: `coverage-${index}`, type: "coverage-obligation" as const, value, relationshipKeys: ["requirement"], referenceFields: { requirementAnalysisArtifactId: "requirement" }, provenance: "agent-draft" })),
    ]);
    const validation = await workspace.finalize("plan");
    if (!validation.valid) throw new QaSkillsError("Bootstrap planning workspace did not satisfy the terminal plan profile", "ARTIFACT_BINDING");
    return { runId: workspace.runId, bundle: { sourceRunId: workspace.runId, artifacts: [...batch.values()].map((artifact) => ({ artifactId: artifact.id, sha256: artifact.sha256 })) } };
  } finally {
    await workspace.close();
  }
}

/** True only for "this file does not exist" -- a permission error, an I/O error, or any other errno
 *  must still surface as the internal error it is, never folded into an edge refusal alongside it. */
function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Reads a run's manifest and metadata, translating "this run does not exist" into a named edge
 *  refusal rather than a raw filesystem crash. Names the run ID given, never the resolved path. */
async function readRunManifestAndMetadata(runPath: string, runId: string, label: string): Promise<{ manifestValue: unknown; metadataValue: unknown }> {
  try {
    const manifestValue: unknown = JSON.parse(await readFile(join(runPath, "artifact-manifest.json"), "utf8"));
    const metadataValue: unknown = JSON.parse(await readFile(join(runPath, "run-metadata.json"), "utf8"));
    return { manifestValue, metadataValue };
  } catch (error: unknown) {
    if (isMissingFileError(error)) throw new QaSkillsError(`${label} run ${runId} was not found`, "INVALID_ARTIFACT");
    throw error;
  }
}

/** Create a closed workflow input from explicit paths; never discovers a "latest" run. */
export async function scaffoldWorkflowInput(options: ScaffoldOptions): Promise<Record<string, unknown>> {
  // Refused at the edge, before any file is even opened: `mode` stays a plain `string` at this CLI
  // boundary (a caller-supplied value, not yet a `PublicWorkflowMode`), so nothing upstream of this line
  // stops a typo from being written into a workflow input that only fails deep inside `workflow run`.
  if (!(publicWorkflowModes as readonly string[]).includes(options.mode)) throw new QaSkillsError(`Workflow mode must be one of ${publicWorkflowModes.join(", ")}`, "INVALID_ARTIFACT");
  // Refused here, at the edge, rather than left a silent no-op the operator would read as armed
  // (task-5b-brief.md, decision 3): `plan` and `exploratory` are the only public modes whose operation
  // list (`directOperations` in src/core/modes.ts) excludes `execute-browser-test`, and the pause this
  // flag arms (`pendingObservedExecution` in src/operations/observed-pause.ts) gates on that exact
  // operation name, so it could never fire for either mode. This is about honesty at the edge, not
  // safety -- the pause predicate itself already gates on the operation regardless of this check.
  if (options.observedExecution === true && (options.mode === "plan" || options.mode === "exploratory")) {
    throw new QaSkillsError(`--observed-execution has no effect in ${options.mode} mode, which never runs execute-browser-test`, "INVALID_ARTIFACT");
  }
  let environmentProfile: Record<string, unknown> | undefined;
  let bundle: Record<string, unknown> | undefined;
  if (options.sourceRoot !== undefined || options.sourceRunId !== undefined) {
    if (!options.sourceRoot || !options.sourceRunId) throw new QaSkillsError("Source root and source run ID must be provided together", "INVALID_ARTIFACT");
    const sourcePath = join(resolve(options.sourceRoot), "qa-results", options.sourceRunId);
    const { manifestValue, metadataValue } = await readRunManifestAndMetadata(sourcePath, options.sourceRunId, "Source");
    if (!isRecord(metadataValue) || !["COMPLETED", "COMPLETED_WITH_FAILURES", "BLOCKED", "ABORTED"].includes(String(metadataValue.status))) throw new QaSkillsError("Source run must be terminal", "INVALID_ARTIFACT");
    if (!isRecord(manifestValue) || !Array.isArray(manifestValue.artifacts)) throw new QaSkillsError("Source artifact manifest is invalid", "INVALID_ARTIFACT");
    const artifacts = manifestValue.artifacts.filter(isRecord).filter((artifact) => [artifact.id, artifact.type, artifact.sha256, artifact.relativePath].every((part) => typeof part === "string"));
    const environment = artifacts.find((artifact) => artifact.type === "environment-profile");
    if (!environment) throw new QaSkillsError("Source run has no environment profile", "INVALID_ARTIFACT");
    const value: unknown = JSON.parse(await readFile(join(sourcePath, environment.relativePath as string), "utf8"));
    if (!isRecord(value)) throw new QaSkillsError("Source environment profile is invalid", "INVALID_ARTIFACT");
    environmentProfile = value;
    const planningKinds = new Set(["requirement-analysis", "test-plan", "test-case", "coverage-obligation"]);
    const infrastructureKinds = new Set(["environment-profile", "run-metadata", "artifact-manifest", "workflow-checkpoint"]);
    const selected = artifacts.filter((artifact) => planningKinds.has(artifact.type as string));
    const disallowed = artifacts.filter((artifact) => !planningKinds.has(artifact.type as string) && !infrastructureKinds.has(artifact.type as string));
    if (disallowed.length > 0) throw new QaSkillsError(`Source run contains non-planning artifact ${String(disallowed[0]?.type)}`, "INVALID_ARTIFACT");
    for (const required of planningKinds) if (!selected.some((artifact) => artifact.type === required)) throw new QaSkillsError(`Source run lacks required canonical planning artifact ${required}`, "INVALID_ARTIFACT");
    bundle = { sourceRunId: options.sourceRunId, artifacts: selected.map((artifact) => ({ artifactId: artifact.id as string, sha256: artifact.sha256 as string })) };
  } else if (options.environmentPath) {
    const value: unknown = JSON.parse(await readFile(resolve(options.environmentPath), "utf8"));
    if (!isRecord(value)) throw new QaSkillsError("Environment profile file must contain an object", "INVALID_ARTIFACT");
    environmentProfile = value;
  }
  if (!environmentProfile) throw new QaSkillsError("Provide --environment-file or an explicit terminal source run", "INVALID_ARTIFACT");

  let charter: Record<string, unknown> | undefined;
  if (options.charterPath !== undefined) {
    // Validated NOW, at scaffold time, with the exploratory operation's own validator
    // (src/exploratory/charter.js) -- rather than writing an unchecked draft that only fails deep
    // inside `register-exploration-charter` when `workflow run` executes it.
    const value: unknown = JSON.parse(await readFile(resolve(options.charterPath), "utf8"));
    charter = assertExplorationCharter(value);
  }

  let changeScope: Record<string, unknown> | undefined;
  if (options.changeScopePath !== undefined) {
    const value: unknown = JSON.parse(await readFile(resolve(options.changeScopePath), "utf8"));
    // Mirrors `registerChangeScope`'s own refusal (src/regression/change-scope.js) rather than deferring
    // to it: a change scope with no declared changes would otherwise be written into a closed input file
    // that only fails once `select-regression` runs it through that same check.
    if (!isRecord(value) || !Array.isArray(value.changes) || value.changes.length === 0) throw new QaSkillsError("Change scope requires at least one declared change", "INVALID_ARTIFACT");
    changeScope = value;
  }

  let sourceBug: Record<string, unknown> | undefined;
  if (options.bugRunId !== undefined) {
    const bugRunPath = join(resolve(options.root), "qa-results", options.bugRunId);
    const { manifestValue: bugManifestValue, metadataValue: bugMetadataValue } = await readRunManifestAndMetadata(bugRunPath, options.bugRunId, "Bug");
    // The same terminal-status check the bundle path above applies to a source run: a non-terminal run's
    // manifest can still grow, so a bug reference read from it would not be the checksum-bound one the
    // caller will get later.
    if (!isRecord(bugMetadataValue) || !["COMPLETED", "COMPLETED_WITH_FAILURES", "BLOCKED", "ABORTED"].includes(String(bugMetadataValue.status))) throw new QaSkillsError("Bug run must be terminal", "INVALID_ARTIFACT");
    if (!isRecord(bugManifestValue) || !Array.isArray(bugManifestValue.artifacts)) throw new QaSkillsError("Bug run artifact manifest is invalid", "INVALID_ARTIFACT");
    const bugArtifacts = bugManifestValue.artifacts.filter(isRecord).filter((artifact) => [artifact.id, artifact.type, artifact.sha256].every((part) => typeof part === "string"));
    const bugReports = bugArtifacts.filter((artifact) => artifact.type === "bug-report");
    if (bugReports.length === 0) throw new QaSkillsError(`Bug run ${options.bugRunId} holds no bug report`, "INVALID_ARTIFACT");
    // `bugArtifactId`, when given, must itself name a `bug-report`: searching within `bugReports` rather
    // than the unfiltered artifact list means an ID naming some OTHER registered artifact type is refused
    // exactly like an ID that does not exist at all, never silently accepted as a bug reference.
    const selected = options.bugArtifactId === undefined
      ? (bugReports.length === 1 ? bugReports[0] : undefined)
      : bugReports.find((artifact) => artifact.id === options.bugArtifactId);
    if (!selected) {
      throw new QaSkillsError(options.bugArtifactId === undefined
        ? `Bug run ${options.bugRunId} holds several bug reports; name one with --bug-artifact-id`
        : `Bug run ${options.bugRunId} has no bug report artifact ${options.bugArtifactId}`, "INVALID_ARTIFACT");
    }
    sourceBug = { artifactId: selected.id as string, sha256: selected.sha256 as string };
  }

  if (options.resumeRunId !== undefined) {
    const resumeRunPath = join(resolve(options.root), "qa-results", options.resumeRunId);
    // Refusal (task-5b-brief.md, decision 1): reuses the exact helper Task 4 built for `--bug-run-id`
    // and `--source-run-id` so a typo'd or already-cleaned-up run ID is refused here, cleanly, naming the
    // run -- rather than surfacing as the raw ENOENT measured (not guessed) from `RunWorkspace.open`
    // itself (src/core/run-workspace.ts) moments later, deep inside `workflow run`.
    const { metadataValue: resumeMetadataValue } = await readRunManifestAndMetadata(resumeRunPath, options.resumeRunId, "Resume");
    // Refusal (task-5b-brief.md, decision 2): measured, not guessed from the other paths' shape, that
    // `RunWorkspace.open` does NOT itself refuse a terminal run -- it opens successfully, without
    // acquiring a lock (src/core/run-workspace.ts). The refusal instead surfaces deep inside
    // `workflow run`, as `QaSkillsError("Terminal workspace is immutable", "TERMINAL_WORKSPACE")` thrown
    // by `assertWritable` -- either from the resume's first checkpoint write, when the run never had one,
    // or from `workspace.finalize`, when it already did -- and neither path ever names the run ID or the
    // word "resume". Refused here instead, at the edge: unlike every OTHER run this file reads (source,
    // bug), which all require terminal, a resumable run is by definition the opposite -- not terminal.
    //
    // Fails CLOSED on a malformed record too, exactly like its two siblings above (the source-run and
    // bug-run terminal checks, both `!isRecord(...) || !array.includes(...)`): a `run-metadata.json` that
    // parses to something other than a record is uninspected, not proven non-terminal, so writing a resume
    // input around it would defer the same "raw failure three layers downstream" this whole block exists
    // to prevent. The two conditions are reported with two different, accurate messages -- "terminal" would
    // be a lie about metadata that was never actually read as a run.
    if (!isRecord(resumeMetadataValue) || ["COMPLETED", "COMPLETED_WITH_FAILURES", "BLOCKED", "ABORTED"].includes(String(resumeMetadataValue.status))) {
      throw new QaSkillsError(!isRecord(resumeMetadataValue)
        ? `Resume run ${options.resumeRunId} metadata could not be read as a run`
        : `Resume run ${options.resumeRunId} is terminal and cannot be resumed`, "INVALID_ARTIFACT");
    }
  }

  const input: Record<string, unknown> = {
    root: resolve(options.root), mode: options.mode, environmentProfile,
    ...(bundle === undefined ? {} : { bundle }),
    ...(charter === undefined ? {} : { charter }),
    ...(changeScope === undefined ? {} : { changeScope, runtime: { changeScopeSourceId: "local-change-scope" } }),
    ...(sourceBug === undefined ? {} : { linkedRunId: options.bugRunId, retest: { sourceBug } }),
    ...(options.observedExecution === true ? { observedExecution: { expected: true } } : {}),
    ...(options.resumeRunId === undefined ? {} : { resumeRunId: options.resumeRunId }),
  };
  await writeFile(resolve(options.outputPath), `${JSON.stringify(input, null, 2)}\n`, "utf8");
  return input;
}

/** Run the closed public workflow with only package-owned local browser/data/evidence adapters. */
export async function runLocalWorkflow(options: Readonly<{ cwd: string; inputPath: string }>): Promise<WorkflowResult> {
  const parsed: unknown = JSON.parse(await readFile(options.inputPath, "utf8"));
  if (!isRecord(parsed) || typeof parsed.root !== "string" || typeof parsed.mode !== "string" || !isRecord(parsed.environmentProfile)) throw new QaSkillsError("Workflow input must provide root, mode, and environmentProfile", "INVALID_ARTIFACT");
  const config = await loadQaConfig({ cwd: options.cwd });
  const mode = parsed.mode;
  const needsBrowser = mode !== "plan";
  const browser = needsBrowser ? await chromium.launch() : undefined;
  try {
    const data = await TestDataHookRegistry.fromConfig(config, {});
    const input = {
      ...parsed,
      runtime: {
        ...(isRecord(parsed.runtime) ? parsed.runtime : {}),
        ...(needsBrowser ? { browserManagerId: "local-browser", evidencePolicyId: "local-evidence" } : {}),
        ...(mode === "full" ? { testDataRegistryId: "local-data" } : {}),
      },
    } as QaWorkflowInput;
    return await createQaTester({
      ...(browser === undefined ? {} : { browserManagers: { "local-browser": { browser } } }),
      testDataRegistries: { "local-data": data },
      // The registry the CLI could not populate before this branch: without it
      // resolveRuntime(runtime.changeScopeSources, ...) can never resolve, so retest and regression were
      // unreachable through `workflow run` no matter what the input file said (wart MODE-1).
      ...(isRecord(parsed.changeScope) ? { changeScopeSources: { "local-change-scope": parsed.changeScope as never } } : {}),
      evidencePolicies: { "local-evidence": { safety: { screenshot: "on-failure", trace: "on-failure", console: "always", logs: "always", network: "always" } } },
    })(input);
  } finally { await browser?.close(); }
}
