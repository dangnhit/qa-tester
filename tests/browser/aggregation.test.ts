import { expect, describe, it } from "vitest";

import { aggregateStepResults } from "../../src/browser/assertions.js";

describe("aggregateStepResults", () => {
  it("uses deterministic status precedence", () => {
    expect(aggregateStepResults([{ status: "PASSED" }, { status: "NOT_RUN" }])).toBe("NOT_RUN");
    expect(aggregateStepResults([{ status: "FAILED" }, { status: "BLOCKED" }])).toBe("BLOCKED");
    expect(aggregateStepResults([{ status: "FAILED" }, { status: "INCONCLUSIVE" }])).toBe("INCONCLUSIVE");
    expect(aggregateStepResults([{ status: "FAILED" }, { status: "PASSED" }])).toBe("FAILED");
    expect(aggregateStepResults([{ status: "FAILED" }, { status: "NOT_RUN" }])).toBe("FAILED");
  });
});
