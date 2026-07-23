import { describe, expect, it } from "vitest";

import { createBugCandidate } from "../../src/defects/eligibility.js";
import { createIncidentFromAttempt } from "../../src/defects/incidents.js";

const failed = {
  attemptId: "ATTEMPT-1", runId: "20260723T123456Z-ab12cd", testCaseId: "TC-CHECKOUT",
  status: "FAILED", failureClassification: "PRODUCT_DEFECT",
};

describe("defect eligibility", () => {
  it("creates candidates only for registered-style failed product observations", () => {
    expect(createBugCandidate(failed)).toMatchObject({ attemptId: "ATTEMPT-1", runId: failed.runId });
    for (const attempt of [
      { ...failed, status: "PASSED" },
      { ...failed, status: "BLOCKED" },
      { ...failed, failureClassification: "TEST_DEFECT" },
      { ...failed, failureClassification: "ENVIRONMENT_DEFECT" },
      { ...failed, failureClassification: "UNDETERMINED" },
    ]) expect(createBugCandidate(attempt)).toBeNull();
  });

  it("keeps non-product diagnoses as typed incidents or findings", () => {
    expect(createIncidentFromAttempt({ ...failed, failureClassification: "TEST_DEFECT" })).toMatchObject({ kind: "TEST_INCIDENT" });
    expect(createIncidentFromAttempt({ ...failed, failureClassification: "ENVIRONMENT_DEFECT" })).toMatchObject({ kind: "ENVIRONMENT_INCIDENT" });
    expect(createIncidentFromAttempt({ ...failed, failureClassification: "UNDETERMINED" })).toMatchObject({ kind: "INVESTIGATION_FINDING" });
    expect(createIncidentFromAttempt(failed)).toBeNull();
  });
});
