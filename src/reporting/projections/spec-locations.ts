import { array, isRecord } from "../../core/values.js";
import type { ProjectionArtifact, ProjectionLocation } from "./projection-model.js";

/**
 * The identity tag's grammar, copied character-for-character from `report-mapping.ts`'s
 * `identityTagPattern` (report-mapping.ts:41) on purpose: the tag is written once, by the spec author,
 * and read in two places. Two grammars that drift would make a spec that produces a batch entry
 * produce no location, silently.
 *
 * The `g` flag is deliberately NOT copied. `report-mapping.ts` needs it for `matchAll` over one title,
 * checking for a SECOND tag in the same string. This module calls `.exec()` once per spec, across many
 * DIFFERENT titles in one loop; a `g`-flagged `RegExp` carries its `lastIndex` across `.exec()` calls on
 * the SAME instance, so reusing one module-level global-flagged pattern here would silently skip or
 * misread titles depending on where the previous call left `lastIndex` -- a real bug this module must
 * not inherit along with the grammar it is copying.
 */
const identityTagPattern = /\[qa:([^\][/@\s]+)\/([^\][/@\s]+)\/([^\][/@\s]+)@([^\][/@\s]+)\]/;

/** The join key both `specLocationsByEntryIdentity` and `buildProjectionModel` use: the full four-part
 *  identity, never `testCaseId` alone -- keying on `testCaseId` alone would join two entries that
 *  differ only by revision (or only by surface), which is exactly the guess this join must not make. */
export const specLocationKey = (identity: Readonly<{ testCaseId: string; testCaseRevisionId: string; testCaseInstanceId: string; executionSurface: string }>): string =>
  `${identity.testCaseId}/${identity.testCaseRevisionId}/${identity.testCaseInstanceId}@${identity.executionSurface}`;

/**
 * Every spec node reachable from a sanitized report's `suites`, recursing through nested suites.
 *
 * Measured from `sanitize-report.ts`'s `projectSuite` (sanitize-report.ts:99-105): a projected suite
 * keeps `specs` (an array of projected spec nodes) and, ONLY when the source suite had one, a nested
 * `suites` array of the SAME projected shape -- one entry per project-level suite, then one per file,
 * then one per `describe()` block, arbitrarily deep. A spec can therefore sit under any number of
 * nested suites, so finding every spec requires recursing into `suites` at every level, not just
 * reading the top one.
 *
 * Defensive against a payload that is not shaped this way at all -- notably the REAL `evidence`
 * artifact `value` a `test-result-batch` entry's `evidenceArtifactIds` actually names, which is the
 * descriptor `registerEvidenceBundle` builds (subject/kind/binaryArtifactIds/...), not the sanitized
 * report: `array(undefined)` and a non-record suite node both fall through to `[]` rather than throwing.
 */
function collectSpecs(suites: unknown): readonly Readonly<Record<string, unknown>>[] {
  return array(suites).flatMap((node) => isRecord(node)
    ? [...array(node.specs).filter(isRecord), ...collectSpecs(node.suites)]
    : []);
}

/**
 * Every spec's `[qa:<testCaseId>/<revisionId>/<instanceId>@<surface>]` location, joined from every
 * `evidence` artifact's sanitized report, keyed by the full four-part identity ({@link specLocationKey}).
 *
 * **Excluded, not refused.** Unlike `report-mapping.ts`'s `mapObservedReport` -- which runs at
 * ingestion time and REFUSES the whole run on a malformed or ambiguous tag, because an ambiguous
 * identity there means the workspace cannot tell which registered case ran -- this join runs at
 * reporting time, over an ALREADY-ACCEPTED batch. A location is an annotation on a result that already
 * exists, never a gate on whether it exists, so an untagged spec, a spec whose tag does not parse, and
 * a spec whose file is missing are all silently excluded from the map rather than raised as an error.
 *
 * **A duplicate identity poisons the key rather than being resolved to whichever spec came first.** Two
 * specs claiming the same identity means this join cannot tell which one actually produced the entry,
 * and picking one is a guess wearing a file path -- worse than no location at all, because a wrong
 * location is indistinguishable from a right one to whoever reads it next.
 */
export function specLocationsByEntryIdentity(artifacts: readonly ProjectionArtifact[]): ReadonlyMap<string, ProjectionLocation> {
  const found = new Map<string, ProjectionLocation>();
  const ambiguous = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.record.type !== "evidence") continue;
    for (const spec of collectSpecs(artifact.value.suites)) {
      const title = typeof spec.title === "string" ? spec.title : "";
      const file = typeof spec.file === "string" && spec.file.length > 0 ? spec.file : undefined;
      const match = identityTagPattern.exec(title);
      if (match === null || file === undefined) continue;
      // `?? ""` mirrors `report-mapping.ts`'s own `parseIdentityTag` (report-mapping.ts:140-142): the
      // pattern requires all four groups, so a successful match always populates them, but
      // `noUncheckedIndexedAccess` still types a capture group access as possibly `undefined`.
      const key = specLocationKey({ testCaseId: match[1] ?? "", testCaseRevisionId: match[2] ?? "", testCaseInstanceId: match[3] ?? "", executionSurface: match[4] ?? "" });
      if (found.has(key)) { ambiguous.add(key); continue; }
      found.set(key, typeof spec.line === "number" ? { file, line: spec.line } : { file });
    }
  }
  for (const key of ambiguous) found.delete(key);
  return found;
}
