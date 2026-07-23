import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { chromium } from "@playwright/test";

import { loadQaConfig } from "../config/load-config.js";
import { QaSkillsError } from "../core/errors.js";
import { createQaTester, type QaWorkflowInput, type WorkflowResult } from "../orchestration/qa-tester.js";
import { TestDataHookRegistry } from "../test-data/hooks.js";

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

export type ScaffoldOptions = Readonly<{ root: string; mode: string; outputPath: string; environmentPath?: string; sourceRoot?: string; sourceRunId?: string }>;

/** Create a closed workflow input from explicit paths; never discovers a "latest" run. */
export async function scaffoldWorkflowInput(options: ScaffoldOptions): Promise<Record<string, unknown>> {
  let environmentProfile: Record<string, unknown> | undefined;
  let bundle: Record<string, unknown> | undefined;
  if (options.sourceRoot !== undefined || options.sourceRunId !== undefined) {
    if (!options.sourceRoot || !options.sourceRunId) throw new QaSkillsError("Source root and source run ID must be provided together", "INVALID_ARTIFACT");
    const sourcePath = join(resolve(options.sourceRoot), "qa-results", options.sourceRunId);
    const manifestValue: unknown = JSON.parse(await readFile(join(sourcePath, "artifact-manifest.json"), "utf8"));
    const metadataValue: unknown = JSON.parse(await readFile(join(sourcePath, "run-metadata.json"), "utf8"));
    if (!record(metadataValue) || !["COMPLETED", "COMPLETED_WITH_FAILURES", "BLOCKED", "ABORTED"].includes(String(metadataValue.status))) throw new QaSkillsError("Source run must be terminal", "INVALID_ARTIFACT");
    if (!record(manifestValue) || !Array.isArray(manifestValue.artifacts)) throw new QaSkillsError("Source artifact manifest is invalid", "INVALID_ARTIFACT");
    const artifacts = manifestValue.artifacts.filter(record).filter((artifact) => [artifact.id, artifact.type, artifact.sha256, artifact.relativePath].every((part) => typeof part === "string"));
    const environment = artifacts.find((artifact) => artifact.type === "environment-profile");
    if (!environment) throw new QaSkillsError("Source run has no environment profile", "INVALID_ARTIFACT");
    const value: unknown = JSON.parse(await readFile(join(sourcePath, environment.relativePath as string), "utf8"));
    if (!record(value)) throw new QaSkillsError("Source environment profile is invalid", "INVALID_ARTIFACT");
    environmentProfile = value;
    bundle = { sourceRunId: options.sourceRunId, artifacts: artifacts.filter((artifact) => artifact.type !== "environment-profile" && artifact.type !== "run-metadata" && artifact.type !== "artifact-manifest").map((artifact) => ({ artifactId: artifact.id as string, sha256: artifact.sha256 as string })) };
  } else if (options.environmentPath) {
    const value: unknown = JSON.parse(await readFile(resolve(options.environmentPath), "utf8"));
    if (!record(value)) throw new QaSkillsError("Environment profile file must contain an object", "INVALID_ARTIFACT");
    environmentProfile = value;
  }
  if (!environmentProfile) throw new QaSkillsError("Provide --environment-file or an explicit terminal source run", "INVALID_ARTIFACT");
  const input: Record<string, unknown> = { root: resolve(options.root), mode: options.mode, environmentProfile, ...(bundle === undefined ? {} : { bundle }) };
  await writeFile(resolve(options.outputPath), `${JSON.stringify(input, null, 2)}\n`, "utf8");
  return input;
}

/** Run the closed public workflow with only package-owned local browser/data/evidence adapters. */
export async function runLocalWorkflow(options: Readonly<{ cwd: string; inputPath: string }>): Promise<WorkflowResult> {
  const parsed: unknown = JSON.parse(await readFile(options.inputPath, "utf8"));
  if (!record(parsed) || typeof parsed.root !== "string" || typeof parsed.mode !== "string" || !record(parsed.environmentProfile)) throw new QaSkillsError("Workflow input must provide root, mode, and environmentProfile", "INVALID_ARTIFACT");
  const config = await loadQaConfig({ cwd: options.cwd });
  const mode = parsed.mode;
  const needsBrowser = mode !== "plan";
  const browser = needsBrowser ? await chromium.launch() : undefined;
  try {
    const data = await TestDataHookRegistry.fromConfig(config, {});
    const input = {
      ...parsed,
      runtime: {
        ...(record(parsed.runtime) ? parsed.runtime : {}),
        ...(needsBrowser ? { browserManagerId: "local-browser", evidencePolicyId: "local-evidence" } : {}),
        ...(mode === "full" ? { testDataRegistryId: "local-data" } : {}),
      },
    } as QaWorkflowInput;
    return await createQaTester({
      ...(browser === undefined ? {} : { browserManagers: { "local-browser": { browser } } }),
      testDataRegistries: { "local-data": data },
      evidencePolicies: { "local-evidence": { safety: { screenshot: "on-failure", trace: "on-failure", console: "always", logs: "always", network: "always" } } },
    })(input);
  } finally { await browser?.close(); }
}
