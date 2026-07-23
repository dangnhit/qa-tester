import { describe, expect, it } from "vitest";

import { createTestCaseRevision } from "../../src/planning/testcase-revision.js";

const candidate = {
  testCaseId: "TC-SAVE-001",
  title: "Saves a profile",
  expectedResults: [{ id: "ER-SAVED", requirementId: "REQ-SAVE", authority: "AUTHORITATIVE", text: "A confirmation is shown." }],
  steps: [{ id: "open", action: "navigate", sideEffect: "none" }],
};

describe("createTestCaseRevision", () => {
  it("creates a deterministic SHA-256 revision from canonical content", () => {
    const first = createTestCaseRevision(candidate);
    const second = createTestCaseRevision({
      steps: candidate.steps,
      title: candidate.title,
      expectedResults: candidate.expectedResults,
      testCaseId: candidate.testCaseId,
    });

    expect(first.revisionId).toMatch(/^[a-f0-9]{64}$/);
    expect(second.revisionId).toBe(first.revisionId);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("changes the immutable revision while retaining the logical testcase ID", () => {
    const revision = createTestCaseRevision({ ...candidate, title: "Saves an edited profile" });

    expect(revision.testCaseId).toBe(candidate.testCaseId);
    expect(revision.revisionId).not.toBe(createTestCaseRevision(candidate).revisionId);
  });

  it("orders canonical object keys by Unicode code unit rather than runtime locale", () => {
    const revision = createTestCaseRevision({ ...candidate, metadata: { ä: "umlaut", z: "zed" } });

    expect(revision.metadata).toEqual({ z: "zed", ä: "umlaut" });
  });
});
