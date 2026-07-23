import { describe, expect, it } from "vitest";

import { assertBrowserAssertion } from "../../src/browser/assertions.js";
import { attachTelemetry } from "../../src/browser/playwright/telemetry.js";

describe("browser telemetry", () => {
  it("classifies a deterministic navigation cancellation apart from a network-policy failure", async () => {
    const handlers = new Map<string, (payload: never) => void>();
    const page = { on: (event: string, handler: (payload: never) => void) => { handlers.set(event, handler); } };
    const telemetry = attachTelemetry(page as never);
    const requestFailed = handlers.get("requestfailed");
    if (!requestFailed) throw new Error("Expected requestfailed listener");
    requestFailed({
      failure: () => ({ errorText: "net::ERR_ABORTED" }), isNavigationRequest: () => true, url: () => "https://fixture.test/navigation",
    } as never);

    expect(telemetry.findings).toEqual([expect.objectContaining({ kind: "navigation-cancelled", message: "net::ERR_ABORTED" })]);
    await expect(assertBrowserAssertion(page as never, { kind: "network-policy", allow: [] }, telemetry)).resolves.toBeUndefined();
  });
});
