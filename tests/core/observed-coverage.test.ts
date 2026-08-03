import { describe, expect, it } from "vitest";

import {
  caseIdentity,
  observedCaseIdentities,
  observedCoveredCaseIds,
  observedFailureIdentities,
  observedSelectedCaseIdentities,
} from "../../src/core/observed-coverage.js";

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

describe("caseIdentity", () => {
  it("keeps the triple lane 2 binds an entry on as three components, under the names the index uses", () => {
    expect(caseIdentity("TC-1", "REV-1", "INSTANCE-1")).toEqual({ testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" });
  });

  it("returns undefined when any part is not a string, so a malformed value cannot forge an identity", () => {
    expect(caseIdentity("TC-1", 2, "INSTANCE-1")).toBeUndefined();
    expect(caseIdentity("TC-1", "REV-1", undefined)).toBeUndefined();
  });

  /** Not a style point: `Map` compares with SameValueZero, so three `undefined` components would MATCH
   *  each other under the nested index. The guard is what keeps an unparsed `{}` entry from binding to an
   *  unparsed `{}` test-case payload — a joined key got this for free by returning `undefined`. */
  it("returns undefined for a wholly absent identity, which would otherwise match another absent one", () => {
    expect(caseIdentity(undefined, undefined, undefined)).toBeUndefined();
  });
});

describe("observedCaseIdentities", () => {
  it("reads every entry of every batch in the run", () => {
    const identities = observedCaseIdentities([
      batch("BATCH-1", [{ testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" }]),
      batch("BATCH-2", [{ testCaseId: "TC-2", testCaseRevisionId: "REV-2", testCaseInstanceId: "INSTANCE-2" }]),
    ]);
    expect(identities).toEqual([
      { testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" },
      { testCaseId: "TC-2", testCaseRevisionId: "REV-2", testCaseInstanceId: "INSTANCE-2" },
    ]);
  });

  it("ignores an invalid batch, so a batch that failed its semantic rule cannot suppress driving", () => {
    const identities = observedCaseIdentities([
      batch("BATCH-1", [{ testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" }], false),
    ]);
    expect(identities).toEqual([]);
  });

  it("ignores every other artifact type, so only a Runtime-Observed Execution can claim an identity", () => {
    // `entries` is present deliberately: without it the type filter would be untestable, because the
    // artifact would yield nothing even if the filter let it through.
    const identities = observedCaseIdentities([
      { record: { id: "RESULT-1", type: "test-result", sha256: "c".repeat(64), provenance: "runtime-execution" }, valid: true, value: { entries: [{ status: "PASSED", ...identity }] } },
    ]);
    expect(identities).toEqual([]);
  });

  it.each([["PASSED"], ["FAILED"]] as const)("credits an entry whose status is %s, because the case ran and an outcome was observed", (status) => {
    // FAILED credits the IDENTITY, not the obligation: re-driving a case lane 2 already executed would be
    // a second independent execution, while `evaluateCoverage` (src/planning/coverage.ts) still refuses a
    // non-PASSED attempt, so the obligation stays unmet and the gate still reports it.
    expect(observedCaseIdentities([batch("BATCH-1", [{ ...identity, status }])])).toEqual([identity]);
  });

  it.each([["NOT_RUN"], ["BLOCKED"], ["INCONCLUSIVE"]] as const)("credits nothing for a %s entry, which names a case nothing was learned about", (status) => {
    // The three statuses `deriveRetestVerdict` (src/retest/verdict.ts) maps to CANNOT_VERIFY. A tagged
    // spec that `test.skip`s maps to NOT_RUN, an interrupted one to BLOCKED — neither executed, so
    // neither may suppress lane-1 driving nor count towards a selection's coverage.
    expect(observedCaseIdentities([batch("BATCH-1", [{ ...identity, status }])])).toEqual([]);
  });

  it("credits nothing for an entry with an unrecognized or missing status, because the list is an allow-list", () => {
    expect(observedCaseIdentities([batch("BATCH-1", [{ ...identity, status: "INVENTED" }])])).toEqual([]);
    // Built without the `batch` helper on purpose: the helper defaults a status in, and a status-less
    // entry is exactly what the allow-list has to refuse.
    expect(observedCaseIdentities([
      { record: { id: "BATCH-1", type: "test-result-batch", sha256: "a".repeat(64), provenance: "runtime-observed" }, valid: true, value: { entries: [{ ...identity }] } },
    ])).toEqual([]);
  });

  it("credits per entry, so one execution that skipped some tagged specs covers only the ones that ran", () => {
    const identities = observedCaseIdentities([batch("BATCH-1", [
      { ...identity, status: "PASSED" },
      { testCaseId: "TC-2", testCaseRevisionId: "REV-2", testCaseInstanceId: "INSTANCE-2", status: "NOT_RUN" },
    ])]);
    expect(identities).toEqual([identity]);
  });

  it("credits nothing for an agent-draft batch, the same provenance gate the release gate applies", () => {
    // `registerArtifactValue` defaults an unstamped registration to `agent-draft`, so a producer that
    // forgot the stamp must not be able to suppress driving — `creditsCoverage` (src/core/provenance.ts)
    // is the one shared answer, and release-gate.ts already refuses such a batch coverage credit.
    expect(observedCaseIdentities([batch("BATCH-1", [{ ...identity }], true, "agent-draft")])).toEqual([]);
    expect(observedCaseIdentities([batch("BATCH-1", [{ ...identity }], true, "runtime")])).toEqual([]);
    expect(observedCaseIdentities([batch("BATCH-1", [{ ...identity }], true, "runtime-execution")])).toEqual([identity]);
  });
});

/**
 * The selection-scoped COVERAGE question (Phase 9 item 3.3). Every fixture here holds an UNSELECTED entry
 * — one naming an identity the selection does not — because that is the only fixture that discriminates
 * this from the run-wide question: a test that merely has a batch is answered the same way by both.
 *
 * An unselected entry is an ordinary shape, not a stray artifact: nothing filters the observed suite by
 * the selection, so a single batch normally carries selected and unselected entries together, which is
 * what `BATCH-MIXED` below is.
 */
describe("observedSelectedCaseIdentities", () => {
  const selected = { testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" } as const;
  const unselected = { testCaseId: "TC-OUTSIDE", testCaseRevisionId: "REV-OUTSIDE", testCaseInstanceId: "INSTANCE-OUTSIDE" } as const;

  it("credits nothing from a batch that names only identities outside the selection", () => {
    const artifacts = [batch("BATCH-UNSELECTED", [{ testCaseId: unselected.testCaseId, testCaseRevisionId: unselected.testCaseRevisionId, testCaseInstanceId: unselected.testCaseInstanceId }])];
    // The run-wide reader answers "yes, something was observed" on this exact input; the scoped one must
    // not, or an execution operation can return nothing while the selection was covered by nothing.
    expect(observedCaseIdentities(artifacts)).toEqual([unselected]);
    expect(observedSelectedCaseIdentities(artifacts, [selected])).toEqual([]);
  });

  it("credits the selected identity from a batch that names it alongside an unselected one", () => {
    const artifacts = [batch("BATCH-MIXED", [
      { testCaseId: unselected.testCaseId, testCaseRevisionId: unselected.testCaseRevisionId, testCaseInstanceId: unselected.testCaseInstanceId },
      { testCaseId: selected.testCaseId, testCaseRevisionId: selected.testCaseRevisionId, testCaseInstanceId: selected.testCaseInstanceId },
    ])];
    expect(observedSelectedCaseIdentities(artifacts, [selected])).toEqual([selected]);
  });

  it("keeps every batch-level credit gate the workspace-wide reader applies", () => {
    const entry = { testCaseId: selected.testCaseId, testCaseRevisionId: selected.testCaseRevisionId, testCaseInstanceId: selected.testCaseInstanceId };
    expect(observedSelectedCaseIdentities([batch("BATCH-1", [entry], false)], [selected])).toEqual([]);
    expect(observedSelectedCaseIdentities([batch("BATCH-1", [entry], true, "agent-draft")], [selected])).toEqual([]);
    expect(observedSelectedCaseIdentities([batch("BATCH-1", [{ ...entry, status: "NOT_RUN" }])], [selected])).toEqual([]);
  });

  /** Same trap as `observedCoveredCaseIds`, one layer up: the scope is matched component by component
   *  through the shared nested index, so a selection entry whose components merely rejoin to the same
   *  delimited string does not put an observed identity in scope. */
  it("does not put an identity in scope whose components merely rejoin to a selected one", () => {
    const artifacts = [batch("BATCH-1", [{ testCaseId: "TC-COL", testCaseRevisionId: "X:REV", testCaseInstanceId: "INST" }])];
    expect(observedSelectedCaseIdentities(artifacts, [{ testCaseId: "TC-COL:X", testCaseRevisionId: "REV", testCaseInstanceId: "INST" }])).toEqual([]);
    expect(observedSelectedCaseIdentities(artifacts, [{ testCaseId: "TC-COL", testCaseRevisionId: "X:REV", testCaseInstanceId: "INST" }]))
      .toEqual([{ testCaseId: "TC-COL", testCaseRevisionId: "X:REV", testCaseInstanceId: "INST" }]);
  });

  it("credits nothing when the selection is empty, because an empty selection names no case", () => {
    expect(observedSelectedCaseIdentities([batch("BATCH-1", [{ testCaseId: selected.testCaseId, testCaseRevisionId: selected.testCaseRevisionId, testCaseInstanceId: selected.testCaseInstanceId }])], [])).toEqual([]);
  });
});

/**
 * The FAILURE question, which is NOT scoped to the selection — the asymmetry with the describe above is
 * the property these rows exist to pin. Scoping it made a `regression` run finalize COMPLETED and exit 0
 * while its own observed suite reported a PRODUCT_DEFECT on an unselected case, with nothing else
 * reporting it; the run-level consequence is pinned in
 * tests/operations/selection-scoped-observation.test.ts.
 */
describe("observedFailureIdentities", () => {
  const selected = { testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" } as const;
  const unselected = { testCaseId: "TC-OUTSIDE", testCaseRevisionId: "REV-OUTSIDE", testCaseInstanceId: "INSTANCE-OUTSIDE" } as const;

  it("reports a FAILED entry the selection never named, because this run's own suite observed it", () => {
    const artifacts = [batch("BATCH-MIXED", [
      { testCaseId: selected.testCaseId, testCaseRevisionId: selected.testCaseRevisionId, testCaseInstanceId: selected.testCaseInstanceId, status: "PASSED" },
      { testCaseId: unselected.testCaseId, testCaseRevisionId: unselected.testCaseRevisionId, testCaseInstanceId: unselected.testCaseInstanceId, status: "FAILED" },
    ])];
    // The same input, asked the two ways: the selection covers `TC-1` and only `TC-1`, and the failure on
    // `TC-OUTSIDE` is still reported. One batch carrying both is the ordinary shape.
    expect(observedSelectedCaseIdentities(artifacts, [selected])).toEqual([selected]);
    expect(observedFailureIdentities(artifacts)).toEqual([unselected]);
  });

  it("reports the failure for a FAILED entry the selection does name", () => {
    const artifacts = [batch("BATCH-1", [{ testCaseId: selected.testCaseId, testCaseRevisionId: selected.testCaseRevisionId, testCaseInstanceId: selected.testCaseInstanceId, status: "FAILED" }])];
    expect(observedFailureIdentities(artifacts)).toEqual([selected]);
  });

  it("reports no failure for a PASSED entry, which is the narrower question this asks", () => {
    const artifacts = [batch("BATCH-1", [{ testCaseId: selected.testCaseId, testCaseRevisionId: selected.testCaseRevisionId, testCaseInstanceId: selected.testCaseInstanceId, status: "PASSED" }])];
    expect(observedCaseIdentities(artifacts)).toEqual([selected]);
    expect(observedFailureIdentities(artifacts)).toEqual([]);
  });

  /** The batch-level credit gate is shared with `observedCaseIdentities` rather than restated, and these
   *  rows are what would catch a future second traversal that forgot one of the three filters. */
  it("keeps every batch-level credit gate, so an uncreditable batch reports no failure either", () => {
    const entry = { testCaseId: selected.testCaseId, testCaseRevisionId: selected.testCaseRevisionId, testCaseInstanceId: selected.testCaseInstanceId, status: "FAILED" };
    expect(observedFailureIdentities([batch("BATCH-1", [entry], false)])).toEqual([]);
    expect(observedFailureIdentities([batch("BATCH-1", [entry], true, "agent-draft")])).toEqual([]);
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

  /**
   * Two DISTINCT canonical cases whose components a `:`-joined key would flatten onto one string:
   * `("TC-COL:X", "REV", "INST")` and `("TC-COL", "X:REV", "INST")` both join to `TC-COL:X:REV:INST`.
   * Nothing used to forbid the colon — `test-case.schema.json` gave all three id fields
   * `{ "type": "string", "minLength": 1 }` with no `pattern`; it now forbids `:` in each, so this exact
   * pair can no longer both be registered through a real run, but `observedCoveredCaseIds` takes plain
   * objects and never re-validates them against the schema, so a batch crediting ONE of them must still
   * not credit the other. Crediting both is how a selected case reaches a finalized, valid run executed
   * by neither lane: it is subtracted from the residual lane 1 would drive AND counted towards the
   * checkpoint's union coverage.
   */
  it("does not credit a second case whose components merely rejoin to the same string", () => {
    const covered = observedCoveredCaseIds([
      batch("BATCH-1", [{ testCaseId: "TC-COL", testCaseRevisionId: "X:REV", testCaseInstanceId: "INST" }]),
      testCase("CASE-JOINED-LEFT", "TC-COL:X", "REV", "INST"),
      testCase("CASE-CREDITED", "TC-COL", "X:REV", "INST"),
    ]);
    expect([...covered]).toEqual(["CASE-CREDITED"]);
  });

  it("does not credit a case whose components rejoin onto an observed entry's split differently", () => {
    const covered = observedCoveredCaseIds([
      batch("BATCH-1", [{ testCaseId: "TC-COL:X", testCaseRevisionId: "REV", testCaseInstanceId: "INST" }]),
      testCase("CASE-CREDITED", "TC-COL:X", "REV", "INST"),
      testCase("CASE-JOINED-RIGHT", "TC-COL", "X:REV", "INST"),
    ]);
    expect([...covered]).toEqual(["CASE-CREDITED"]);
  });
});
