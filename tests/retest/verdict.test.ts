import { describe, expect, it } from "vitest";

import { deriveRegressionOutcome, deriveRetestVerdict } from "../../src/retest/verdict.js";

describe("retest verdicts", () => {
  it("evaluates the original bug independently from adjacent regression", () => {
    expect(deriveRetestVerdict({ originalBugId: "BUG-LOGIN-001", reproductionStatuses: ["PASSED"], regressionOutcome: "FAILED" })).toMatchObject({
      bugId: "BUG-LOGIN-001", verdict: "FIXED", regressionOutcome: "FAILED",
    });
  });

  it("recognizes intermittent reproduction without inventing a product conclusion", () => {
    expect(deriveRetestVerdict({ originalBugId: "BUG-LOGIN-001", reproductionStatuses: ["FAILED", "PASSED"] }).verdict).toBe("INTERMITTENT");
  });

  it("distinguishes partial repair across affected scenarios from intermittent repeats of one scenario", () => {
    expect(deriveRetestVerdict({ originalBugId: "BUG-LOGIN-001", reproductionStatuses: ["PASSED", "FAILED"], scenarioIds: ["password", "oauth"] }).verdict).toBe("PARTIALLY_FIXED");
    expect(deriveRetestVerdict({ originalBugId: "BUG-LOGIN-001", reproductionStatuses: ["PASSED", "FAILED"], scenarioIds: ["password", "password"] }).verdict).toBe("INTERMITTENT");
  });

  it("derives a typed regression outcome and rejects unknown execution statuses", () => {
    expect(deriveRegressionOutcome(["PASSED", "FAILED"])).toBe("FAILED");
    expect(() => deriveRegressionOutcome(["UNKNOWN"] as never)).toThrow(/execution status/i);
  });
});
