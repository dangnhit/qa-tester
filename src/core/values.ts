/** True when value is a non-null, non-array object usable as a Record<string, unknown>. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
