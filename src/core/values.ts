/** True when value is a non-null, non-array object usable as a Record<string, unknown>. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerces an unknown to a readonly array, yielding an empty array for non-arrays. */
export function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value as unknown[] : []; }

/** True when `resources` is an array of records whose `id` values are all distinct. */
export function uniqueResourceIds(resources: unknown): resources is Record<string, unknown>[] {
  return Array.isArray(resources)
    && resources.every(isRecord)
    && new Set(resources.map((resource) => resource.id)).size === resources.length;
}

/**
 * Deterministic canonical JSON for CHECKSUM inputs only: object keys sorted lexicographically at
 * every level; array order preserved. undefined policy: values are emitted via `JSON.stringify`, so
 * an `undefined` object-property value serializes to the literal text `undefined` (deterministic but
 * non-standard JSON) and `undefined` array elements collapse to an empty segment. This exact byte
 * output is depended on by checkpointStateChecksum and workflowStateChecksum — do not "fix" it.
 *
 * Two other canonicalizers intentionally remain SEPARATE (different, observable output):
 *  - src/planning/testcase-revision.ts#canonicalJson  — omits undefined props; feeds sha256 fingerprints
 *  - src/reporting/render-json.ts#renderCanonicalJson  — native, insertion-ordered, pretty-printed report bytes
 * Merging either would change fingerprints / report bytes and is out of scope for this behavior-preserving pass.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
