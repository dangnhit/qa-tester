import { describe, expect, it } from "vitest";

import { caseIdentityKey, observedCaseIdentities, observedCoveredCaseIds } from "../../src/core/observed-coverage.js";

function batch(id: string, entries: readonly Record<string, unknown>[], valid = true) {
  return { record: { id, type: "test-result-batch", sha256: "a".repeat(64) }, value: { entries }, valid };
}

function testCase(id: string, testCaseId: string, revisionId: string, instanceId: string, valid = true) {
  return { record: { id, type: "test-case", sha256: "b".repeat(64) }, value: { testCaseId, revisionId, instanceId }, valid };
}

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
      { record: { id: "RESULT-1", type: "test-result", sha256: "c".repeat(64) }, valid: true, value: { entries: [{ testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" }] } },
    ]);
    expect(identities.size).toBe(0);
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
