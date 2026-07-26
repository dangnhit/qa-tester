/**
 * Shared `Map` indices over registered-artifact collections (Task 30), replacing the
 * `.find()` / `.filter()` / `.some()`-per-attempt linear scans the validation core ran once per probe.
 *
 * Three properties are load-bearing, because every consumer is behavior-critical validation code:
 *
 * 1. **Arrays, never single values.** `.find()` returns the FIRST match while `.filter()` returns ALL
 *    of them, and several call sites then read `matches.length !== 1` to detect an ambiguous binding.
 *    An index keyed to a single artifact would erase exactly the signal those checks exist to read, so
 *    `get` always returns the FULL bucket and each call site keeps its own `[0]` / `.length` decision.
 * 2. **Source order.** Buckets are appended while iterating the source array front-to-back, so
 *    `get(key)` yields the same items, in the same order, that `source.filter(...)` would have — which
 *    is what makes `get(key)[0]` equal to `source.find(...)` for the same equality predicate.
 * 3. **Key equality is `Map` equality, not string equality.** Keys are stored RAW. `Map` compares with
 *    SameValueZero, which coincides with `===` for every value `JSON.parse` can produce (JSON has no
 *    `NaN`; `0` and `-0` compare equal under both), so an indexed lookup admits exactly the items the
 *    original `===` predicate admitted. Nothing is serialized into a delimited string, so no charset
 *    assumption is made about ids — `test-case`/`test-result` only constrain their identity fields to
 *    `{ "type": "string", "minLength": 1 }`, so a `` `${a}|${b}|${c}` `` join would be free to collide.
 *    The identity triple is a NESTED map for the same reason.
 *
 * An index is a SNAPSHOT of the array it was built from. `inspectWorkspaceState` runs a
 * `while (changed)` fixpoint whose valid pool SHRINKS between passes, so an index over that pool must
 * be rebuilt inside the loop; one built outside would serve a stale, too-large pool and let a rule bind
 * to an artifact that has already been invalidated.
 *
 * This is a `src/core/` leaf: it imports nothing, and nothing outward may be imported into it.
 */

/** The full bucket for a key, in source order; empty when nothing carried that key. */
export type ArtifactIndex<T> = Readonly<{
  get(key: unknown): readonly T[];
  /** Every non-empty bucket, in first-appearance order of its key — for duplicate detection. */
  groups(): Iterable<readonly T[]>;
}>;

/** The test-case identity triple. Field names are the `test-case` payload's own; `test-result` and
 *  `evidence` spell the same three values `testCaseId` / `testCaseRevisionId` / `testCaseInstanceId`,
 *  so the selector each call site supplies is what reconciles the naming drift. */
export type TestCaseIdentity = Readonly<{ testCaseId: unknown; revisionId: unknown; instanceId: unknown }>;

export type TestCaseIdentityIndex<T> = Readonly<{ get(identity: TestCaseIdentity): readonly T[] }>;

/** One shared frozen empty bucket: a miss must be indistinguishable from an empty `.filter()` result. */
const noMatches: readonly never[] = Object.freeze([]);

/** Index `items` by one key. The general single-value index — attempt ids, evidence ids, and any other
 *  field a call site compared with `===`. See `indexByAttemptId` for the attempt-keyed specialization. */
export function indexByKey<T>(items: readonly T[], keyOf: (item: T) => unknown): ArtifactIndex<T> {
  const buckets = new Map<unknown, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [item]);
    else bucket.push(item);
  }
  return {
    get: (key) => buckets.get(key) ?? noMatches,
    groups: () => buckets.values(),
  };
}

/** Index `items` by the attempt they claim. The attempt id is not always `value.attemptId` — schema
 *  2.0.0 `evidence` carries it inside its `subject` union — so the caller supplies the accessor. */
export function indexByAttemptId<T>(items: readonly T[], attemptIdOf: (item: T) => unknown): ArtifactIndex<T> {
  return indexByKey(items, attemptIdOf);
}

/** Index `items` by the immutable test-case identity triple, as a nested map so no component of the
 *  triple can bleed into another (see property 3 above). */
export function indexByTestCaseIdentity<T>(
  items: readonly T[],
  identityOf: (item: T) => TestCaseIdentity,
): TestCaseIdentityIndex<T> {
  const buckets = new Map<unknown, Map<unknown, Map<unknown, T[]>>>();
  for (const item of items) {
    const { testCaseId, revisionId, instanceId } = identityOf(item);
    let byRevision = buckets.get(testCaseId);
    if (byRevision === undefined) {
      byRevision = new Map<unknown, Map<unknown, T[]>>();
      buckets.set(testCaseId, byRevision);
    }
    let byInstance = byRevision.get(revisionId);
    if (byInstance === undefined) {
      byInstance = new Map<unknown, T[]>();
      byRevision.set(revisionId, byInstance);
    }
    const bucket = byInstance.get(instanceId);
    if (bucket === undefined) byInstance.set(instanceId, [item]);
    else bucket.push(item);
  }
  return {
    get: ({ testCaseId, revisionId, instanceId }) =>
      buckets.get(testCaseId)?.get(revisionId)?.get(instanceId) ?? noMatches,
  };
}
