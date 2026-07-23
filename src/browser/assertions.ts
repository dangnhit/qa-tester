import type { Page } from "@playwright/test";

import type { ExecutionStatus } from "../contracts/types.js";
import { resolveLocator } from "./locator.js";
import type { BrowserAssertion, BrowserTelemetry, SecretResolver, StringValue } from "./types.js";

const precedence: readonly ExecutionStatus[] = ["BLOCKED", "INCONCLUSIVE", "FAILED", "NOT_RUN", "PASSED"];

export function aggregateStepResults(results: readonly { status: ExecutionStatus }[]): ExecutionStatus {
  return precedence.find((status) => results.some((result) => result.status === status)) ?? "NOT_RUN";
}

export async function resolveValue(value: StringValue, resolver?: SecretResolver): Promise<string> {
  if (typeof value === "string") return value;
  if (resolver === undefined) throw new Error(`No secret resolver was provided for ${value.secretRef}`);
  return resolver(value);
}

function failed(message: string): never { throw new Error(message); }

export async function assertBrowserAssertion(
  page: Page,
  assertion: BrowserAssertion,
  telemetry: BrowserTelemetry,
  resolver?: SecretResolver,
): Promise<void> {
  switch (assertion.kind) {
    case "visible": if (!await resolveLocator(page, assertion.locator).isVisible()) failed("Expected locator to be visible"); return;
    case "text": {
      const actual = await resolveLocator(page, assertion.locator).textContent();
      if (actual !== assertion.text) failed(`Expected text ${assertion.text}, received ${actual ?? "null"}`);
      return;
    }
    case "value": {
      const actual = await resolveLocator(page, assertion.locator).inputValue();
      const expected = await resolveValue(assertion.value, resolver);
      if (actual !== expected) failed(`Expected value ${expected}, received ${actual}`);
      return;
    }
    case "url": if (page.url() !== assertion.url) failed(`Expected URL ${assertion.url}, received ${page.url()}`); return;
    case "count": {
      const actual = await resolveLocator(page, assertion.locator).count();
      if (actual !== assertion.count) failed(`Expected ${assertion.count} elements, received ${actual}`);
      return;
    }
    case "enabled": if (!await resolveLocator(page, assertion.locator).isEnabled()) failed("Expected locator to be enabled"); return;
    case "disabled": if (await resolveLocator(page, assertion.locator).isEnabled()) failed("Expected locator to be disabled"); return;
    case "checked": if (!await resolveLocator(page, assertion.locator).isChecked()) failed("Expected locator to be checked"); return;
    case "response-status": {
      const statuses = telemetry.responseStatuses.get(assertion.url) ?? [];
      if (!statuses.includes(assertion.status)) failed(`Expected response ${assertion.status} for ${assertion.url}`);
      return;
    }
    case "console-policy": {
      const allowed = assertion.allow ?? [];
      const violations = telemetry.findings.filter((finding) => finding.kind === "console" && (assertion.level === undefined || finding.level === assertion.level) && !allowed.includes(finding.message));
      if (violations.length > 0) failed(`Console policy violated: ${violations[0]?.message}`);
      return;
    }
    case "network-policy": {
      const allowed = assertion.allow ?? [];
      const violations = telemetry.findings.filter((finding) => finding.kind === "network" && !allowed.includes(finding.url ?? ""));
      if (violations.length > 0) failed(`Network policy violated: ${violations[0]?.message}`);
      return;
    }
    default: throw new Error(`Unsupported browser assertion: ${(assertion as { kind?: unknown }).kind === undefined ? "unknown" : String((assertion as { kind: unknown }).kind)}`);
  }
}
