import { describe, expect, it } from "vitest";

import { creditsAttestation, creditsCoverage, type ExecutionProvenance } from "../../src/core/provenance.js";

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

/** The attestation sibling of `creditsCoverage`. Both readers of a Human Attestation used to credit one
 *  on an artifact-type + `obligationSha256` join alone, while every attempt path beside them was
 *  provenance-gated — a credit path with no witness check, on a model whose whole claim is that credit
 *  must be witnessed. `human-attestation.schema.json` already asserted the guard in its `attestedBy`
 *  description ("this field plus the manifest record's `human-attestation:<identity>` provenance, which
 *  no agent-draft path can write"); nothing enforced it. */
describe("creditsAttestation", () => {
  it("credits an attestation stamped by `qa-skill attestation record`", () => {
    expect(creditsAttestation("human-attestation:reviewer@example.test")).toBe(true);
  });

  it("does not credit the agent-draft provenance an unstamped registration defaults to", () => {
    expect(creditsAttestation("agent-draft")).toBe(false);
  });

  it("does not credit a runtime provenance", () => {
    expect(creditsAttestation("runtime")).toBe(false);
  });

  /** The two lanes that credit an ATTEMPT are exactly the ones that cannot witness a manual
   *  evaluation; the gate must not accept one standing in for the other in either direction. */
  it.each(["runtime-execution", "runtime-observed"])("does not credit the %s execution lane", (provenance) => {
    expect(creditsAttestation(provenance)).toBe(false);
  });

  /** An approval authorises a plan; an attestation records that an evaluation happened. The glossary's
   *  own `_Avoid_` line names "sign-off, approval decision" as what a Human Attestation must not be
   *  confused with, and the prefixes are close enough to be worth pinning. */
  it("does not credit a human-approval provenance", () => {
    expect(creditsAttestation("human-approval:qa-lead")).toBe(false);
  });

  it("does not credit a bare prefix naming nobody", () => {
    expect(creditsAttestation("human-attestation:")).toBe(false);
  });

  it("does not credit a value that merely contains the prefix", () => {
    expect(creditsAttestation("runtime-import:RUN-1:human-attestation:reviewer")).toBe(false);
  });

  it("does not credit an undefined provenance", () => {
    expect(creditsAttestation(undefined)).toBe(false);
  });
});
