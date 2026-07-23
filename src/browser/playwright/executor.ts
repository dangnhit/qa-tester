import type { Page } from "@playwright/test";

import { assertBrowserAssertion, resolveValue } from "../assertions.js";
import { resolveLocator } from "../locator.js";
import type { BrowserAction, BrowserStepResult, BrowserTelemetry, BrowserTestStep, SecretResolver } from "../types.js";

export async function executeAction(page: Page, action: BrowserAction, resolver?: SecretResolver): Promise<void> {
  switch (action.kind) {
    case "open": await page.goto(await resolveValue(action.url, resolver)); return;
    case "click": await resolveLocator(page, action.locator).click(); return;
    case "fill": await resolveLocator(page, action.locator).fill(await resolveValue(action.value, resolver)); return;
    case "select": await resolveLocator(page, action.locator).selectOption(await resolveValue(action.value, resolver)); return;
    case "check": await resolveLocator(page, action.locator).check(); return;
    case "uncheck": await resolveLocator(page, action.locator).uncheck(); return;
    case "press": await resolveLocator(page, action.locator).press(action.key); return;
    case "upload": await resolveLocator(page, action.locator).setInputFiles(action.files); return;
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
): Promise<BrowserStepResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  try {
    await executeAction(page, step.action, resolver);
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
