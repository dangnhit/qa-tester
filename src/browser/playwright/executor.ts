import type { Page } from "@playwright/test";

import { QaSkillsError } from "../../core/errors.js";
import { assertRealpathWithin } from "../../core/fs.js";
import { assertNavigable, type LaneSafetyContext } from "../../safety/navigation.js";
import { assertBrowserAssertion, resolveValue } from "../assertions.js";
import { resolveLocator } from "../locator.js";
import type { BrowserAction, BrowserStepResult, BrowserTelemetry, BrowserTestStep, SecretResolver } from "../types.js";

export async function executeAction(page: Page, action: BrowserAction, resolver?: SecretResolver, safety?: LaneSafetyContext): Promise<void> {
  switch (action.kind) {
    case "open": {
      const resolvedUrl = await resolveValue(action.url, resolver);
      // Fail closed: the DSL `open` step must never navigate without a lane-1 safety context.
      if (safety === undefined) throw new QaSkillsError("Navigation refused: no lane-1 safety context was supplied for the open step", "UNSAFE_NAVIGATION");
      await assertNavigable(resolvedUrl, safety.navigation);
      await page.goto(resolvedUrl);
      return;
    }
    case "click": await resolveLocator(page, action.locator).click(); return;
    case "fill": await resolveLocator(page, action.locator).fill(await resolveValue(action.value, resolver)); return;
    case "select": await resolveLocator(page, action.locator).selectOption(await resolveValue(action.value, resolver)); return;
    case "check": await resolveLocator(page, action.locator).check(); return;
    case "uncheck": await resolveLocator(page, action.locator).uncheck(); return;
    case "press": await resolveLocator(page, action.locator).press(action.key); return;
    case "upload": {
      // Fail closed: an upload must never reach Playwright without a lane-1 safety context.
      if (safety === undefined) throw new QaSkillsError("Upload refused: no lane-1 safety context was supplied for the upload step", "UNSAFE_UPLOAD");
      // Constrain every file to the runtime-owned upload root (path-traversal /
      // absolute-outside / symlink-escape all rejected; the leaf must exist) and
      // hand Playwright the canonical realpath'd paths, never the raw caller strings.
      const files = await Promise.all(action.files.map((file) => assertRealpathWithin(safety.uploadRoot, file)));
      await resolveLocator(page, action.locator).setInputFiles(files);
      return;
    }
    case "wait": {
      if (action.locator !== undefined) await resolveLocator(page, action.locator).waitFor();
      else await page.waitForTimeout(action.milliseconds ?? 0);
      return;
    }
    default: throw new Error(`Unsupported browser action: ${(action as { kind?: unknown }).kind === undefined ? "unknown" : String((action as { kind: unknown }).kind)}`);
  }
}

export async function executeBrowserStep(
  page: Page,
  step: BrowserTestStep,
  telemetry: BrowserTelemetry,
  resolver?: SecretResolver,
  safety?: LaneSafetyContext,
): Promise<BrowserStepResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  try {
    await executeAction(page, step.action, resolver, safety);
  } catch (error) {
    const finished = Date.now();
    return { stepId: step.id, status: "FAILED", startedAt, finishedAt: new Date(finished).toISOString(), durationMs: finished - started, action: step.action, assertions: step.assertions ?? [], error: error instanceof Error ? error.message : String(error), failureOrigin: "action" };
  }
  for (const assertion of step.assertions ?? []) {
    try {
      await assertBrowserAssertion(page, assertion, telemetry, resolver);
    } catch (error) {
      const finished = Date.now();
      return { stepId: step.id, status: "FAILED", startedAt, finishedAt: new Date(finished).toISOString(), durationMs: finished - started, action: step.action, assertions: step.assertions ?? [], error: error instanceof Error ? error.message : String(error), failureOrigin: "assertion", failedAssertion: assertion };
    }
  }
  const finished = Date.now();
  return { stepId: step.id, status: "PASSED", startedAt, finishedAt: new Date(finished).toISOString(), durationMs: finished - started, action: step.action, assertions: step.assertions ?? [] };
}
