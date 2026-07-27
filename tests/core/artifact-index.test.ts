import { describe, expect, it } from "vitest";

import { indexByKey, indexByTestCaseIdentity, type TestCaseIdentity } from "../../src/core/artifact-index.js";

// Direct unit coverage for `src/core/artifact-index.ts` (Task 30's shared Map indices), which today is
// only exercised transitively through the ~67 call sites that consume it. Its own doc comment names four
// properties as load-bearing for every one of those consumers; this file pins exactly those, and nothing
// the module does not itself promise.

type Tagged = Readonly<{ id: string; key: unknown }>;

describe("indexByKey", () => {
  it("keeps a bucket's items in source order, front-to-back", () => {
    const items: Tagged[] = [
      { id: "first", key: "shared" },
      { id: "other", key: "different" },
      { id: "second", key: "shared" },
      { id: "third", key: "shared" },
    ];
    const index = indexByKey(items, (item) => item.key);
    expect(index.get("shared").map((item) => item.id)).toEqual(["first", "second", "third"]);
  });

  it("keeps raw numeric 0 and string \"0\" as distinct keys, rather than collapsing them via string-joining", () => {
    const items: Tagged[] = [
      { id: "number-zero", key: 0 },
      { id: "string-zero", key: "0" },
    ];
    const index = indexByKey(items, (item) => item.key);
    expect(index.get(0).map((item) => item.id)).toEqual(["number-zero"]);
    expect(index.get("0").map((item) => item.id)).toEqual(["string-zero"]);
  });
});

describe("a miss on either index shape", () => {
  it("returns the same empty bucket for repeated misses within one index instance, not a fresh allocation per miss", () => {
    const keyIndex = indexByKey<Tagged>([{ id: "present", key: "known" }], (item) => item.key);
    const identityIndex = indexByTestCaseIdentity<Tagged & TestCaseIdentity>(
      [{ id: "present", key: "known", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1" }],
      (item) => item,
    );

    const missFromKeyIndexA = keyIndex.get("missing-a");
    const missFromKeyIndexB = keyIndex.get("missing-b");
    const missFromIdentityIndex = identityIndex.get({ testCaseId: "TC-none", testCaseRevisionId: "REV-none", testCaseInstanceId: "INST-none" });

    expect(missFromKeyIndexA).toEqual([]);
    // Within a single `indexByKey` instance, every miss is the SAME array instance — not merely two
    // separately-allocated empty arrays that happen to be equal. That is the module's own no-copy
    // guarantee (property 4 in the file header): `get` never allocates a fresh array per call.
    expect(missFromKeyIndexA).toBe(missFromKeyIndexB);
    // A miss from a *different* index instance (here, a separately-built `indexByTestCaseIdentity`) is
    // only guaranteed to be content-equal, never reference-equal — the module documents no cross-instance
    // identity guarantee, and no consumer among the ~67 call sites compares a miss by reference.
    expect(missFromIdentityIndex).toEqual([]);
  });
});

describe("indexByTestCaseIdentity", () => {
  it("preserves full multiplicity (and source order) for an ambiguous identity triple, rather than collapsing to one match", () => {
    const identity = (item: TestCaseIdentity & { id: string }): TestCaseIdentity => item;
    const items = [
      { id: "revision-a", testCaseId: "TC-1", testCaseRevisionId: "REV-A", testCaseInstanceId: "INST-1" },
      // Duplicate registration of the same identity triple: several call sites read `.length !== 1` on
      // exactly this shape to detect an orphan-or-ambiguous binding, so a single-value index would
      // silently destroy the signal those checks exist to read.
      { id: "duplicate-1", testCaseId: "TC-1", testCaseRevisionId: "REV-B", testCaseInstanceId: "INST-1" },
      { id: "duplicate-2", testCaseId: "TC-1", testCaseRevisionId: "REV-B", testCaseInstanceId: "INST-1" },
    ];
    const index = indexByTestCaseIdentity(items, identity);

    expect(index.get({ testCaseId: "TC-1", testCaseRevisionId: "REV-A", testCaseInstanceId: "INST-1" })).toHaveLength(1);
    const ambiguous = index.get({ testCaseId: "TC-1", testCaseRevisionId: "REV-B", testCaseInstanceId: "INST-1" });
    expect(ambiguous.map((item) => item.id)).toEqual(["duplicate-1", "duplicate-2"]);
  });

  it("keeps components of the identity triple in their own nested map, not joined into one delimited key", () => {
    // The triple is nested (`Map<Map<Map>>`), not `` `${a}|${b}|${c}` ``-joined, precisely so a component
    // boundary can never bleed into a neighboring component's value. A numeric vs. string mismatch on one
    // component, with the others held constant, is the case a join would risk colliding.
    const identity = (item: TestCaseIdentity & { id: string }): TestCaseIdentity => item;
    const items = [
      { id: "numeric-revision", testCaseId: "TC-1", testCaseRevisionId: 1, testCaseInstanceId: "INST-1" },
      { id: "string-revision", testCaseId: "TC-1", testCaseRevisionId: "1", testCaseInstanceId: "INST-1" },
    ];
    const index = indexByTestCaseIdentity(items, identity);

    expect(index.get({ testCaseId: "TC-1", testCaseRevisionId: 1, testCaseInstanceId: "INST-1" }).map((item) => item.id)).toEqual(["numeric-revision"]);
    expect(index.get({ testCaseId: "TC-1", testCaseRevisionId: "1", testCaseInstanceId: "INST-1" }).map((item) => item.id)).toEqual(["string-revision"]);
  });
});
