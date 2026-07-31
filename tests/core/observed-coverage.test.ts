import { describe, expect, it } from "vitest";

import { caseIdentityKey, observedCaseIdentities, observedCoveredCaseIds } from "../../src/core/observed-coverage.js";

/** `PASSED` is the default status because an entry with NO status covers nothing since Phase 8b Task 3:
 *  these fixtures are about the identity and provenance filters, and would otherwise all test the status
 *  one by accident. `runtime-observed` is the provenance the real producer stamps
 *  (src/operations/execute-observed-playwright.ts). */
function batch(id: string, entries: readonly Record<string, unknown>[], valid = true, provenance = "runtime-observed") {
  return { record: { id, type: "test-result-batch", sha256: "a".repeat(64), provenance }, value: { entries: entries.map((entry) => ({ status: "PASSED", ...entry })) }, valid };
}

function testCase(id: string, testCaseId: string, revisionId: string, instanceId: string, valid = true) {
  return { record: { id, type: "test-case", sha256: "b".repeat(64), provenance: `runtime-import:RUN-SOURCE:${id}` }, value: { testCaseId, revisionId, instanceId }, valid };
}

const identity = { testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" } as const;

describe("caseIdentityKey", () => {
  it("joins the triple lane 2 binds an entry on", () => {
    expect(caseIdentityKey("TC-1", "REV-1", "INSTANCE-1")).toBe("TC-1:REV-1:INSTANCE-1");
  });

  it("returns undefined when any part is not a string, so a malformed value cannot forge an identity", () => {
    expect(caseIdentityKey("TC-1", 2, "INSTANCE-1")).toBeUndefined();
    expect(caseIdentityKey("TC-1", "REV-1", undefined)).toBeUndefined();
  });
});

describe("observedCaseIdentities", () => {
  it("reads every entry of every batch in the run", () => {
    const identities = observedCaseIdentities([
      batch("BATCH-1", [{ testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" }]),
      batch("BATCH-2", [{ testCaseId: "TC-2", testCaseRevisionId: "REV-2", testCaseInstanceId: "INSTANCE-2" }]),
    ]);
    expect([...identities].sort()).toEqual(["TC-1:REV-1:INSTANCE-1", "TC-2:REV-2:INSTANCE-2"]);
  });

  it("ignores an invalid batch, so a batch that failed its semantic rule cannot suppress driving", () => {
    const identities = observedCaseIdentities([
      batch("BATCH-1", [{ testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" }], false),
    ]);
    expect(identities.size).toBe(0);
  });

  it("ignores every other artifact type, so only a Runtime-Observed Execution can claim an identity", () => {
    // `entries` is present deliberately: without it the type filter would be untestable, because the
    // artifact would yield nothing even if the filter let it through.
    const identities = observedCaseIdentities([
      { record: { id: "RESULT-1", type: "test-result", sha256: "c".repeat(64), provenance: "runtime-execution" }, valid: true, value: { entries: [{ status: "PASSED", ...identity }] } },
    ]);
    expect(identities.size).toBe(0);
  });

  it.each([["PASSED"], ["FAILED"]] as const)("credits an entry whose status is %s, because the case ran and an outcome was observed", (status) => {
    // FAILED credits the IDENTITY, not the obligation: re-driving a case lane 2 already executed would be
    // a second independent execution, while `evaluateCoverage` (src/planning/coverage.ts) still refuses a
    // non-PASSED attempt, so the obligation stays unmet and the gate still reports it.
    expect([...observedCaseIdentities([batch("BATCH-1", [{ ...identity, status }])])]).toEqual(["TC-1:REV-1:INSTANCE-1"]);
  });

  it.each([["NOT_RUN"], ["BLOCKED"], ["INCONCLUSIVE"]] as const)("credits nothing for a %s entry, which names a case nothing was learned about", (status) => {
    // The three statuses `deriveRetestVerdict` (src/retest/verdict.ts) maps to CANNOT_VERIFY. A tagged
    // spec that `test.skip`s maps to NOT_RUN, an interrupted one to BLOCKED — neither executed, so
    // neither may suppress lane-1 driving nor count towards a selection's coverage.
    expect(observedCaseIdentities([batch("BATCH-1", [{ ...identity, status }])]).size).toBe(0);
  });

  it("credits nothing for an entry with an unrecognized or missing status, because the list is an allow-list", () => {
    expect(observedCaseIdentities([batch("BATCH-1", [{ ...identity, status: "INVENTED" }])]).size).toBe(0);
    // Built without the `batch` helper on purpose: the helper defaults a status in, and a status-less
    // entry is exactly what the allow-list has to refuse.
    expect(observedCaseIdentities([
      { record: { id: "BATCH-1", type: "test-result-batch", sha256: "a".repeat(64), provenance: "runtime-observed" }, valid: true, value: { entries: [{ ...identity }] } },
    ]).size).toBe(0);
  });

  it("credits per entry, so one execution that skipped some tagged specs covers only the ones that ran", () => {
    const identities = observedCaseIdentities([batch("BATCH-1", [
      { ...identity, status: "PASSED" },
      { testCaseId: "TC-2", testCaseRevisionId: "REV-2", testCaseInstanceId: "INSTANCE-2", status: "NOT_RUN" },
    ])]);
    expect([...identities]).toEqual(["TC-1:REV-1:INSTANCE-1"]);
  });

  it("credits nothing for an agent-draft batch, the same provenance gate the release gate applies", () => {
    // `registerArtifactValue` defaults an unstamped registration to `agent-draft`, so a producer that
    // forgot the stamp must not be able to suppress driving — `creditsCoverage` (src/core/provenance.ts)
    // is the one shared answer, and release-gate.ts already refuses such a batch coverage credit.
    expect(observedCaseIdentities([batch("BATCH-1", [{ ...identity }], true, "agent-draft")]).size).toBe(0);
    expect(observedCaseIdentities([batch("BATCH-1", [{ ...identity }], true, "runtime")]).size).toBe(0);
    expect([...observedCaseIdentities([batch("BATCH-1", [{ ...identity }], true, "runtime-execution")])]).toEqual(["TC-1:REV-1:INSTANCE-1"]);
  });
});

describe("observedCoveredCaseIds", () => {
  it("maps an observed identity onto the registered test-case artifact that declares it", () => {
    const covered = observedCoveredCaseIds([
      batch("BATCH-1", [{ testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" }]),
      testCase("CASE-1", "TC-1", "REV-1", "INSTANCE-1"),
      testCase("CASE-2", "TC-2", "REV-2", "INSTANCE-2"),
    ]);
    expect([...covered]).toEqual(["CASE-1"]);
  });

  it("covers nothing when the identity differs in the instance alone", () => {
    const covered = observedCoveredCaseIds([
      batch("BATCH-1", [{ testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-OTHER" }]),
      testCase("CASE-1", "TC-1", "REV-1", "INSTANCE-1"),
    ]);
    expect(covered.size).toBe(0);
  });
});
