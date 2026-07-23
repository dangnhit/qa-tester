import { describe, expect, it } from "vitest";

import { resolveEvidencePolicy } from "../../src/evidence/policy.js";

describe("resolveEvidencePolicy", () => {
  it("applies safety, profile, run, and testcase constraints without allowing testcase to lower a minimum", () => {
    const policy = resolveEvidencePolicy({
      safety: { screenshot: "required", logs: "required", video: "forbidden" },
      profile: { screenshot: "on-failure", logs: "optional", console: "required" },
      run: { screenshot: "off", trace: "on-failure" },
      testcase: { screenshot: "off", logs: "off", trace: "always", video: "always" },
    });

    expect(policy.screenshot).toBe("required");
    expect(policy.logs).toBe("required");
    expect(policy.console).toBe("required");
    expect(policy.trace).toBe("always");
    expect(policy.video).toBe("forbidden");
  });

  it("uses the safe defaults for a live browser attempt", () => {
    expect(resolveEvidencePolicy({})).toEqual({
      logs: "always",
      console: "always",
      network: "always",
      screenshot: "on-failure",
      trace: "on-failure",
      video: "off",
    });
  });
});
