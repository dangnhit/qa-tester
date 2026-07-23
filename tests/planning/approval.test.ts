import { describe, expect, it } from "vitest";

import { evaluateApproval } from "../../src/planning/approval.js";

const safeCandidate = {
  expectedResults: [{ id: "ER-LOGIN", requirementId: "REQ-LOGIN", authority: "AUTHORITATIVE", text: "Account page opens." }],
  dslValid: true,
  openQuestions: [],
  steps: [
    { id: "open", sideEffect: "none" },
    { id: "seed", sideEffect: "reversible", cleanup: { declared: true } },
  ],
};

const safePolicy = { mode: "auto-approve-safe" } as const;

describe("evaluateApproval", () => {
  it("auto-approves a fully safe authoritative non-production candidate", () => {
    expect(evaluateApproval(safeCandidate, safePolicy, { classification: "staging" })).toMatchObject({ approved: true, mode: "AUTO_APPROVED" });
  });

  it("requires human approval for production even when the candidate is otherwise safe", () => {
    expect(evaluateApproval(safeCandidate, safePolicy, { classification: "production" })).toMatchObject({ approved: false, mode: "HUMAN_REVIEW", reasons: expect.arrayContaining(["production-target"]) });
  });

  it("rejects unsafe auto-approval for non-authoritative assertions, open questions, invalid DSL, and uncleanable effects", () => {
    const decision = evaluateApproval({
      ...safeCandidate,
      expectedResults: [{ ...safeCandidate.expectedResults[0], authority: "INFERRED" }],
      dslValid: false,
      openQuestions: ["Does this redirect?"],
      steps: [{ id: "charge", sideEffect: "external" }],
    }, safePolicy, { classification: "test" });

    expect(decision).toMatchObject({ approved: false, mode: "HUMAN_REVIEW" });
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "non-authoritative-assertion",
      "invalid-dsl",
      "open-questions",
      "unsafe-side-effect",
    ]));
  });
});
