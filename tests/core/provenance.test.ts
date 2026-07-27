import { describe, expect, it } from "vitest";

import { creditsCoverage, type ExecutionProvenance } from "../../src/core/provenance.js";

describe("creditsCoverage", () => {
  it("credits a runtime-execution (lane 1) result", () => {
    expect(creditsCoverage("runtime-execution")).toBe(true);
  });

  it("credits a runtime-observed (lane 2) result", () => {
    expect(creditsCoverage("runtime-observed")).toBe(true);
  });

  it("does not credit an agent-draft result", () => {
    expect(creditsCoverage("agent-draft")).toBe(false);
  });

  it("does not credit an unrelated provenance value", () => {
    expect(creditsCoverage("runtime")).toBe(false);
  });

  it("does not credit a human-approval provenance value", () => {
    expect(creditsCoverage("human-approval:qa-lead")).toBe(false);
  });

  /** A Human Attestation is evidence that a MANUAL evaluation happened, not that the QA Runtime
   *  executed or observed anything — so it is not an execution lane and must never credit an
   *  obligation through the attempt path. What a manual Accessibility Obligation does with it is
   *  Task 35's decision, made somewhere other than here. */
  it("does not credit a human-attestation provenance value", () => {
    expect(creditsCoverage("human-attestation:accessibility-reviewer")).toBe(false);
  });

  it("does not credit an undefined provenance", () => {
    expect(creditsCoverage(undefined)).toBe(false);
  });

  it("accepts every ExecutionProvenance union member as a valid input", () => {
    const members: readonly ExecutionProvenance[] = ["runtime-execution", "runtime-observed", "agent-draft"];
    expect(members.map((member) => creditsCoverage(member))).toEqual([true, true, false]);
  });
});
