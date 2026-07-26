import { describe, expect, it } from "vitest";

import { evidenceAttemptId, evidenceSubject } from "../../src/core/artifact-record.js";

const attemptSubject = { kind: "attempt", attemptId: "ATTEMPT-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" };

describe("evidenceSubject", () => {
  it("reads a complete attempt subject", () => {
    expect(evidenceSubject({ subject: attemptSubject })).toEqual(attemptSubject);
  });

  it("reads an observed-execution subject", () => {
    expect(evidenceSubject({ subject: { kind: "observed-execution", executionId: "EXEC-1" } })).toEqual({ kind: "observed-execution", executionId: "EXEC-1" });
  });

  // The schema rejects these before a validated artifact reaches a read site, so this is the defensive
  // floor: an unreadable subject must resolve to `undefined` and force the caller to decide explicitly,
  // never to a partially-populated object that could match a foreign artifact by accident.
  it.each([
    ["a non-record value", "evidence"],
    ["a value with no subject", {}],
    ["a non-record subject", { subject: "attempt" }],
    ["an unknown subject kind", { subject: { kind: "observed-attempt", attemptId: "ATTEMPT-1" } }],
    ["an attempt subject missing testCaseInstanceId", { subject: { kind: "attempt", attemptId: "ATTEMPT-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1" } }],
    ["an attempt subject with a non-string attemptId", { subject: { ...attemptSubject, attemptId: 1 } }],
    ["an observed-execution subject with a non-string executionId", { subject: { kind: "observed-execution", executionId: 1 } }],
  ])("returns undefined for %s", (_label, value) => {
    expect(evidenceSubject(value)).toBeUndefined();
  });
});

describe("evidenceAttemptId", () => {
  it("returns the attempt ID of an attempt subject", () => {
    expect(evidenceAttemptId({ subject: attemptSubject })).toBe("ATTEMPT-1");
  });

  it("returns undefined for an observed-execution subject, which binds no attempt", () => {
    expect(evidenceAttemptId({ subject: { kind: "observed-execution", executionId: "EXEC-1" } })).toBeUndefined();
  });

  it("returns undefined for a malformed subject", () => {
    expect(evidenceAttemptId({ subject: { kind: "attempt" } })).toBeUndefined();
  });
});
