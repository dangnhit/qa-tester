import { readFile } from "node:fs/promises";

import { chromium } from "@playwright/test";

import { loadQaConfig } from "../config/load-config.js";
import { QaSkillsError } from "../core/errors.js";
import { createQaTester, type QaWorkflowInput, type WorkflowResult } from "../orchestration/qa-tester.js";
import { TestDataHookRegistry } from "../test-data/hooks.js";

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

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
