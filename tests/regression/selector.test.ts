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

  it("lets one testcase cover every matching change and retains deterministic combined rationale", () => {
    const result = selectRegressionCases({
      changes: [
        { id: "change-a", requirementIds: ["REQ-A"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] },
        { id: "change-b", requirementIds: ["REQ-B"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] },
      ],
      testCases: [{ testCaseId: "TC-SHARED", revisionId: "REV-1", instanceId: "WEB", requirementIds: ["REQ-A", "REQ-B"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }],
    });
    expect(result).toMatchObject({ complete: true, unmappedChangeRisks: [] });
    expect(result.selected).toEqual([expect.objectContaining({ testCaseId: "TC-SHARED", source: "requirement-mapping", rationale: "requirement-mapping matched REQ-A for change-a; requirement-mapping matched REQ-B for change-b" })]);
  });

  /**
   * The identity is three components, never one `:`-joined string. `("TC-COL:X", "REV-COL", "I")` and
   * `("TC-COL", "X:REV-COL", "I")` are two schema-valid canonical cases — `test-case.schema.json`
   * constrains each component only to a non-empty string — that rejoin to one key.
   *
   * A joined decision key collapsed them into ONE decision, and which one survived was decided by the
   * order the caller passed them in. No caller chooses that order: an imported bundle arrives sorted by
   * source artifact id (`buildCanonicalPlanImportBatch`, src/operations/run-workflow.ts), and those are
   * ULIDs whose relative order is random when two registrations land in the same millisecond. So the
   * assertion below is about reproducibility as much as about correctness — a selection that is not a
   * function of its input SET is one a resumed run cannot recompute.
   */
  const collidingChange = { id: "change-col", requirementIds: ["REQ-COL"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] };
  const collidingCase = (testCaseId: string, revisionId: string, requirementIds: readonly string[]) =>
    ({ testCaseId, revisionId, instanceId: "INSTANCE-COL", requirementIds: [...requirementIds], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] });

  it("keeps two identities that rejoin to the same string apart, in an order their arrival cannot change", () => {
    const first = collidingCase("TC-COL:X", "REV-COL", ["REQ-COL"]);
    const second = collidingCase("TC-COL", "X:REV-COL", ["REQ-COL"]);
    const forward = selectRegressionCases({ changes: [collidingChange], testCases: [first, second] });
    const reversed = selectRegressionCases({ changes: [collidingChange], testCases: [second, first] });

    expect(forward.selected.map((decision) => [decision.testCaseId, decision.revisionId])).toEqual([["TC-COL", "X:REV-COL"], ["TC-COL:X", "REV-COL"]]);
    expect(forward.excluded).toEqual([]);
    expect(reversed).toEqual(forward);
  });

  it("keeps the collision apart when the colon crosses the revision boundary instead of the id one", () => {
    // The same rejoin, one component over: `("TC-COL", "REV:X", "INSTANCE-COL")` and
    // `("TC-COL", "REV", "X:INSTANCE-COL")` share a testCaseId as well as a joined key, so the order is
    // settled by the revision — the term after the id in the total order.
    const first = { ...collidingCase("TC-COL", "REV:X", ["REQ-COL"]), instanceId: "INSTANCE-COL" };
    const second = { ...collidingCase("TC-COL", "REV", ["REQ-COL"]), instanceId: "X:INSTANCE-COL" };
    const forward = selectRegressionCases({ changes: [collidingChange], testCases: [first, second] });
    const reversed = selectRegressionCases({ changes: [collidingChange], testCases: [second, first] });

    expect(forward.selected.map((decision) => [decision.revisionId, decision.instanceId])).toEqual([["REV", "X:INSTANCE-COL"], ["REV:X", "INSTANCE-COL"]]);
    expect(reversed).toEqual(forward);
  });

  it("excludes the colliding case no change selected, rather than dropping it from both lists", () => {
    // Only the first maps to the declared change. Under a joined key the second matched the decision the
    // FIRST one had already written, so it appeared in neither `selected` nor `excluded` — a registered
    // case nobody was accountable for executing.
    const result = selectRegressionCases({
      changes: [collidingChange],
      testCases: [collidingCase("TC-COL:X", "REV-COL", ["REQ-COL"]), collidingCase("TC-COL", "X:REV-COL", [])],
    });

    expect(result.selected.map((decision) => [decision.testCaseId, decision.revisionId])).toEqual([["TC-COL:X", "REV-COL"]]);
    expect(result.excluded.map((decision) => [decision.testCaseId, decision.revisionId])).toEqual([["TC-COL", "X:REV-COL"]]);
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
