import { describe, expect, it } from "vitest";

import { expandTestCase } from "../../src/planning/parameterization.js";
import { createTestCaseRevision } from "../../src/planning/testcase-revision.js";

const revision = createTestCaseRevision({
  testCaseId: "TC-LOGIN-001",
  title: "Signs in",
  expectedResults: [{ id: "ER-LOGIN", requirementId: "REQ-LOGIN", authority: "AUTHORITATIVE", text: "The account page opens." }],
  steps: [{ id: "open", action: "navigate", sideEffect: "none" }],
});

describe("expandTestCase", () => {
  it("expands unique parameter sets across the browser matrix without changing logical identity", () => {
    const instances = expandTestCase(revision, {
      parameterSets: [{ locale: "en" }, { locale: "vi" }, { locale: "en" }],
      browserMatrix: [
        { browser: "chromium", viewport: { width: 1440, height: 900 } },
        { browser: "webkit", viewport: { width: 390, height: 844 } },
      ],
    });

    expect(instances).toHaveLength(4);
    expect(new Set(instances.map((instance) => instance.instanceId)).size).toBe(4);
    expect(new Set(instances.map((instance) => instance.testCaseId))).toEqual(new Set([revision.testCaseId]));
    expect(instances.every((instance) => instance.revisionId === revision.revisionId)).toBe(true);
  });

  it("does not generate duplicate logical instances for repeated parameter and browser members", () => {
    const instances = expandTestCase(revision, {
      parameterSets: [{ account: "standard" }, { account: "standard" }],
      browserMatrix: [{ browser: "chromium", viewport: { width: 1280, height: 720 } }, { browser: "chromium", viewport: { height: 720, width: 1280 } }],
    });

    expect(instances).toHaveLength(1);
  });
});
