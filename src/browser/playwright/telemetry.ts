import type { Page } from "@playwright/test";

import type { BrowserTelemetry } from "../types.js";

function timestamp(): string { return new Date().toISOString(); }

function isNavigationCancellation(errorText: string, navigation: boolean): boolean {
  return navigation && /(?:ERR_ABORTED|NS_BINDING_ABORTED|navigation.*cancelled)/i.test(errorText);
}

export function attachTelemetry(page: Page): BrowserTelemetry {
  const telemetry: BrowserTelemetry = { findings: [], responseStatuses: new Map() };
  page.on("console", (message) => {
    telemetry.findings.push({ kind: "console", message: message.text(), level: message.type(), timestamp: timestamp() });
  });
  page.on("response", (response) => {
    const url = response.url();
    const statuses = telemetry.responseStatuses.get(url) ?? [];
    statuses.push(response.status());
    telemetry.responseStatuses.set(url, statuses);
  });
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText ?? "request failed";
    telemetry.findings.push({
      kind: isNavigationCancellation(errorText, request.isNavigationRequest()) ? "navigation-cancelled" : "network",
      message: errorText,
      url: request.url(),
      timestamp: timestamp(),
    });
  });
  return telemetry;
}
