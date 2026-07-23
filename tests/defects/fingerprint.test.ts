import { describe, expect, it } from "vitest";

import { BugFingerprintRegistry, createBugFingerprint, createRunScopedBugId } from "../../src/defects/fingerprint.js";

describe("bug fingerprints", () => {
  it("creates deterministic run-suffixed IDs and normalized fingerprints", () => {
    expect(createRunScopedBugId("checkout", "20260723T123456Z-ab12cd", 7)).toBe("BUG-CHECKOUT-AB12CD-007");
    expect(createBugFingerprint({ feature: "Checkout", expected: "Order is saved", actual: "500 error", affectedAreas: ["payments", "orders"] }))
      .toBe(createBugFingerprint({ feature: " checkout ", expected: "order is saved", actual: "500   error", affectedAreas: ["orders", "payments"] }));
  });

  it("consolidates only within a run and labels cross-run matches possible duplicates", () => {
    const registry = new BugFingerprintRegistry();
    const fingerprint = createBugFingerprint({ feature: "Checkout", expected: "Saved", actual: "500", affectedAreas: ["orders"] });
    expect(registry.register({ runId: "run-a", bugId: "BUG-A", fingerprint })).toEqual({ kind: "NEW" });
    expect(registry.register({ runId: "run-a", bugId: "BUG-B", fingerprint })).toEqual({ kind: "CONSOLIDATED", canonicalBugId: "BUG-A" });
    expect(registry.register({ runId: "run-b", bugId: "BUG-C", fingerprint })).toEqual({ kind: "POSSIBLE_DUPLICATE", possibleDuplicateBugIds: ["BUG-A"] });
  });
});
