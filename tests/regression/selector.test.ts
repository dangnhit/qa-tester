import { describe, expect, it } from "vitest";

import { selectRegressionCases } from "../../src/regression/selector.js";
import { regressionMappingSources } from "../../src/orchestration/qa-tester.js";

describe("regression selection", () => {
  it("prefers requirement mapping over lower-priority mapping and explains exclusions", () => {
    const result = selectRegressionCases({
      changes: [{ id: "change-login", requirementIds: ["REQ-LOGIN"], codeSurfaces: ["auth.ts"], declaredDependencies: [], gitPaths: [], userScope: [] }],
      testCases: [
        { testCaseId: "TC-REQ", revisionId: "REV-1", instanceId: "REQ-A", requirementIds: ["REQ-LOGIN"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] },
        { testCaseId: "TC-CODE", revisionId: "REV-1", instanceId: "CODE-A", requirementIds: [], codeSurfaces: ["auth.ts"], declaredDependencies: [], gitPaths: [], userScope: [] },
        { testCaseId: "TC-NONE", revisionId: "REV-1", instanceId: "NONE-A", requirementIds: [], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] },
      ],
    });
    expect(result.selected.map((entry) => [entry.testCaseId, entry.source])).toEqual([["TC-REQ", "requirement-mapping"], ["TC-CODE", "code-surface-mapping"]]);
    expect(result.excluded).toEqual([expect.objectContaining({ testCaseId: "TC-NONE", rationale: expect.any(String), confidence: expect.any(Number) })]);
  });

  it("exposes unmapped changes and refuses a complete claim", () => {
    const result = selectRegressionCases({ changes: [{ id: "unknown", requirementIds: [], codeSurfaces: [], declaredDependencies: [], gitPaths: ["new.ts"], userScope: [] }], testCases: [] });
    expect(result).toMatchObject({ complete: false, unmappedChangeRisks: [expect.objectContaining({ changeId: "unknown" })] });
  });

  it("exposes every canonical mapping source from the public QA Tester surface and preserves its priority", () => {
    expect(regressionMappingSources).toEqual(["requirement-mapping", "code-surface-mapping", "declared-dependency", "git-diff-heuristic", "user-scope"]);
    const result = selectRegressionCases({
      changes: [{ id: "priority", requirementIds: ["req"], codeSurfaces: ["surface"], declaredDependencies: ["dependency"], gitPaths: ["path"], userScope: ["scope"] }],
      testCases: [{ testCaseId: "TC-ALL", revisionId: "REV-ALL", instanceId: "ALL-A", requirementIds: ["req"], codeSurfaces: ["surface"], declaredDependencies: ["dependency"], gitPaths: ["path"], userScope: ["scope"] }],
    });
    expect(result.selected).toEqual([expect.objectContaining({ source: "requirement-mapping" })]);
  });
});
