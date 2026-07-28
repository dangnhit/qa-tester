import { describe, expect, it } from "vitest";

import { evaluateApproval, resolvePlanApproval } from "../../src/planning/approval.js";

const safeCandidate = {
  expectedResults: [{ id: "ER-LOGIN", requirementId: "REQ-LOGIN", authority: "AUTHORITATIVE", text: "Account page opens." }],
  dslValid: true,
  openQuestions: [],
  steps: [
    { id: "open", action: { kind: "navigate", url: "/login" }, sideEffect: "none" },
    { id: "seed", action: { kind: "fill", locator: { testId: "email" }, value: "qa@example.test" }, sideEffect: "reversible", cleanup: { declared: true } },
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

  it("validates bounded actions rather than trusting a draft dslValid assertion", () => {
    const decision = evaluateApproval({
      ...safeCandidate,
      dslValid: true,
      steps: [{ id: "script", action: { kind: "evaluate", script: "document.cookie" }, sideEffect: "none" }],
    }, safePolicy, { classification: "test" });

    expect(decision).toMatchObject({ approved: false, reasons: expect.arrayContaining(["invalid-dsl"]) });
  });
});

/**
 * `resolvePlanApproval` is the one predicate both the `execute-browser-test` refusal and the
 * `AWAITING_HUMAN_INPUT` pause read, so the two cannot drift apart. `approved` is what the refusal
 * checks; `awaitsHumanReview` is `recordHumanApproval`'s own precondition — the only state
 * `qa-skill approval record` can resolve, and therefore the only state worth pausing a run for.
 *
 * It is exercised here rather than through a workspace on purpose. `RunWorkspace` refuses to register
 * an `auto-approve-safe` plan whose derived decision is not approved at all ("Unsafe auto-approval:
 * …"), so the "unapproved but nothing can approve it" case is unreachable through registration — the
 * predicate still has to answer it correctly for any caller that reaches it another way, and a pure
 * test is the only way to pin that answer.
 */
describe("resolvePlanApproval", () => {
  const planRecord = { id: "ART-PLAN", type: "test-plan", sha256: "a".repeat(64), relationships: [] };
  const testCase = { record: { id: "ART-CASE", type: "test-case", sha256: "b".repeat(64), relationships: ["ART-PLAN"] }, value: {} };
  const plan = (value: Record<string, unknown>) => ({ record: planRecord, value });
  const approvalArtifact = (overrides: Record<string, unknown> = {}) => ({
    record: { id: "ART-APPROVAL", type: "approval-decision", sha256: "c".repeat(64), relationships: ["ART-PLAN"] },
    value: { planArtifactId: "ART-PLAN", planSha256: "a".repeat(64), decision: "APPROVED", ...overrides },
  });
  const pending = { approvalPolicy: { mode: "human-review" }, approvalDecision: { approved: false, mode: "HUMAN_REVIEW", reasons: ["policy-requires-human-review"] } };

  it("reports an auto-approved plan as approved and not awaiting anyone", () => {
    expect(resolvePlanApproval([plan({ approvalPolicy: { mode: "auto-approve-safe" }, approvalDecision: { approved: true, mode: "AUTO_APPROVED", reasons: [] } }), testCase], testCase))
      .toMatchObject({ approved: true, awaitsHumanReview: false });
  });

  it("reports a pending human-review plan as awaiting a person", () => {
    expect(resolvePlanApproval([plan(pending), testCase], testCase)).toMatchObject({ approved: false, awaitsHumanReview: true });
  });

  it("stops awaiting once a matching approval-decision names the plan's exact bytes", () => {
    expect(resolvePlanApproval([plan(pending), testCase, approvalArtifact()], testCase)).toMatchObject({ approved: true, awaitsHumanReview: false });
  });

  it.each([
    ["a stale plan checksum", { planSha256: "d".repeat(64) }],
    ["a decision that is not an approval", { decision: "REJECTED" }],
  ] as const)("keeps awaiting a person when the approval-decision carries %s", (_label, overrides) => {
    expect(resolvePlanApproval([plan(pending), testCase, approvalArtifact(overrides)], testCase)).toMatchObject({ approved: false, awaitsHumanReview: true });
  });

  it("reports an unapproved auto-approve-safe plan as neither approved nor awaiting — no command can resolve it", () => {
    expect(resolvePlanApproval([plan({ approvalPolicy: { mode: "auto-approve-safe" }, approvalDecision: { approved: false, mode: "HUMAN_REVIEW", reasons: ["open-questions"] } }), testCase], testCase))
      .toMatchObject({ approved: false, awaitsHumanReview: false });
  });

  it("reports a test case bound to no plan as neither approved nor awaiting", () => {
    expect(resolvePlanApproval([testCase], testCase)).toEqual({ approved: false, awaitsHumanReview: false });
  });
});
