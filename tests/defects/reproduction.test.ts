import { describe, expect, it } from "vitest";

import { evaluateReproduction } from "../../src/defects/reproduction.js";

const failed = { attemptId: "A1", status: "FAILED", failureClassification: "PRODUCT_DEFECT" };

describe("evaluateReproduction", () => {
  it("uses exactly two total safe attempts including the original", () => {
    expect(evaluateReproduction([failed, { ...failed, attemptId: "A2" }])).toMatchObject({ attempted: 2, total: 2, outcome: "REPRODUCED", rate: "2/2" });
    expect(evaluateReproduction([failed, { ...failed, attemptId: "A2", status: "PASSED", failureClassification: "NONE" }])).toMatchObject({ attempted: 2, total: 2, outcome: "INTERMITTENT", rate: "1/2" });
  });

  it("retains an unsafe rerun omission and marks mixed multi-attempt results intermittent", () => {
    expect(evaluateReproduction([failed], { unsafeRerunReason: "Would charge a real card" })).toMatchObject({ attempted: 1, total: 2, outcome: "RERUN_OMITTED_UNSAFE", rate: "1/2", unsafeRerunReason: "Would charge a real card" });
    expect(evaluateReproduction([failed, { ...failed, attemptId: "A2", status: "PASSED", failureClassification: "NONE" }, { ...failed, attemptId: "A3" }])).toMatchObject({ outcome: "INTERMITTENT", rate: "2/3" });
  });
});
