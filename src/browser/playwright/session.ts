import type { Browser } from "@playwright/test";

import { attachTelemetry } from "./telemetry.js";
import type { ActiveBrowserSession, BrowserTestInstance } from "../types.js";

export async function createBrowserAttemptSession(browser: Browser, testCase: BrowserTestInstance): Promise<ActiveBrowserSession> {
  const viewport = testCase.browser?.viewport;
  const context = await browser.newContext(viewport === undefined ? {} : { viewport });
  const page = await context.newPage();
  const telemetry = attachTelemetry(page);
  return { context, page, telemetry };
}
