import { describe, expect, it } from "vitest";

import { createTriage } from "../../src/defects/triage.js";

describe("bug triage", () => {
  it("does not assign severity before triage", () => {
    expect(createTriage({ status: "NEEDS_TRIAGE", openQuestions: ["What user impact occurs?"] })).toEqual({ triageStatus: "NEEDS_TRIAGE", openQuestions: ["What user impact occurs?"] });
    expect(() => createTriage({ status: "NEEDS_TRIAGE", openQuestions: [], severity: "Major" })).toThrow(/severity/i);
  });

  it.each(["Blocker", "Critical", "Major", "Minor", "Trivial"] as const)("uses exact triaged severity %s separately from priority and testcase priority", (severity) => {
    expect(createTriage({ status: "TRIAGED", severity, priorityRecommendation: "P1", testPriority: "high", openQuestions: [] }))
      .toMatchObject({ triageStatus: "TRIAGED", severity, priorityRecommendation: "P1", testPriority: "high" });
  });
});
