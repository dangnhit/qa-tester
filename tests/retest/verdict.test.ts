import { describe, expect, it } from "vitest";

import { deriveRetestVerdict } from "../../src/retest/verdict.js";

describe("retest verdicts", () => {
  it("evaluates the original bug independently from adjacent regression", () => {
    expect(deriveRetestVerdict({ originalBugId: "BUG-LOGIN-001", reproductionStatuses: ["PASSED"], regressionOutcome: "FAILED" })).toMatchObject({
      bugId: "BUG-LOGIN-001", verdict: "FIXED", regressionOutcome: "FAILED",
    });
  });

  it("recognizes intermittent reproduction without inventing a product conclusion", () => {
    expect(deriveRetestVerdict({ originalBugId: "BUG-LOGIN-001", reproductionStatuses: ["FAILED", "PASSED"] }).verdict).toBe("INTERMITTENT");
  });
});
