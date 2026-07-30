import { isAbsolute, resolve } from "node:path";

import { isPathWithin, manifestRelativePath } from "../../core/fs.js";
import { array, isRecord } from "../../core/values.js";
import type { ProjectionLocation } from "./projection-model.js";

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
 * Nothing upstream schema-validates these payloads -- they are the CONTENT of a registered binary, and
 * `validateArtifact` never runs on a binary's bytes -- so this traversal is the only thing standing
 * between an unexpected shape and a crash.
 */
function collectSpecs(suites: unknown): readonly Readonly<Record<string, unknown>>[] {
  return array(suites).flatMap((node) => isRecord(node)
    ? [...array(node.specs).filter(isRecord), ...collectSpecs(node.suites)]
    : []);
}

/**
 * One spec's `file`, rebased onto the run root and spelled the way SARIF reads `artifactLocation.uri` --
 * or `undefined`, in which case the spec contributes NO location rather than a wrong one.
 *
 * **`spec.file` is `config.rootDir`-relative, and this repo's own runtime is the authority for that.**
 * `execute-observed-playwright.ts` resolves the identical field as `resolve(rootDir, file)` when it
 * decides which specs an execution really ran. SARIF -- and GitHub code scanning reading it -- resolves
 * `artifactLocation.uri` against the REPOSITORY ROOT. Copying `spec.file` across unchanged therefore
 * emitted `checkout.spec.ts` for a file living at `e2e/checkout.spec.ts` under the ordinary
 * `testDir: "./e2e"` configuration: a URI naming a file that is not there, in a code-scanning UI, with
 * nothing in the export saying so.
 *
 * **An absent or relative `config.rootDir` yields no location, deliberately.** `sanitizeRunnerReport`
 * keeps `rootDir` (it is in its `configKeys` allowlist) and Playwright's JSON reporter always emits it,
 * absolute, as part of `FullConfig` -- so a payload without one is not a sanitized Playwright report,
 * and `file` has no stated base to be relative TO. Treating it as run-root-relative would be a guess
 * about a payload whose shape is already unrecognised, and the runtime's own position is that `file` is
 * meaningless without `rootDir`. Requiring `rootDir` to be ABSOLUTE additionally keeps this reducer free
 * of `process.cwd()`: `resolve(absolute, anything)` never consults it, so the same payload yields the
 * same URI from any working directory.
 *
 * **Containment is the validation, and it is fail-closed.** `file` was previously accepted as any
 * non-empty string, so an absolute path or one spelling `..` segments travelled verbatim into that same
 * UI. The check is deliberately containment rather than "is it absolute": an absolute `file` INSIDE the
 * run root is a true location and rebases correctly (and `resolve` gives an absolute `file` precedence
 * over `rootDir`, exactly as the runtime's own `resolve(rootDir, file)` does), while any `file` landing
 * outside -- absolute or traversed -- yields nothing. `assertExecutedSpecsAreAnchored` constrains where
 * a resolved spec path may land, but it runs at execution time and never on this path, so the export
 * must ask the question itself. This is the same policy the neighbouring `line` guard applies, one field
 * out: refuse the field this reducer cannot vouch for.
 *
 * The cost is stated rather than hidden: the comparison is LEXICAL, because a pure reducer cannot call
 * `realpath` and the spec files need not even exist on the machine running the export. A `rootDir` and
 * a `runRoot` that reach the same directory through different spellings -- a symlinked `/tmp` prefix on
 * macOS, or a run workspace exported on a different machine from the one that produced it -- therefore
 * yield no locations. That is the fail-closed direction: no location rather than a wrong one.
 *
 * `manifestRelativePath` rather than a local `relative(...)`: a SARIF URI is separator-sensitive in
 * exactly the way a manifest `relativePath` is, and `e2e\checkout.spec.ts` is as broken to GitHub as it
 * is to the manifest reader. `isPathWithin` rather than a local prefix test, for the reason `fa6c60c`
 * records: a containment call site that re-derives the decision loses the `..${sep}` marker and the
 * cross-drive rejection that primitive exists to carry.
 */
function runRootRelativeUri(runRoot: string, rootDir: string | undefined, file: unknown): string | undefined {
  if (rootDir === undefined || typeof file !== "string" || file.length === 0) return undefined;
  const absolute = resolve(rootDir, file);
  if (!isPathWithin(runRoot, absolute)) return undefined;
  const uri = manifestRelativePath(runRoot, absolute);
  // A spec resolving to the run root ITSELF is not a file position: `uri` would be the empty string,
  // which SARIF would accept as a uri-reference and no reader could act on.
  return uri.length === 0 ? undefined : uri;
}

/**
 * Every spec's `[qa:<testCaseId>/<revisionId>/<instanceId>@<surface>]` location, joined from every
 * sanitized runner report, keyed by the full four-part identity ({@link specLocationKey}).
 *
 * **It takes the PARSED REPORTS, not the artifacts that reference them, and that is not a convenience.**
 * A sanitized runner report is registered as a BINARY (`execute-observed-playwright.ts:379-396`:
 * `mediaType: "application/json"`), and `inspect-workspace-state.ts:324` returns early for any record
 * carrying a `mediaType` — so `RunWorkspace.readRegisteredArtifacts` never parses those bytes into any
 * artifact's `.value`. The `evidence` artifact it DOES expose is only the descriptor
 * (subject/kind/relativePath/binaryArtifacts/...), which carries no `suites` at all. Handed artifacts,
 * this function would therefore return an empty map on every real run. Reading the file itself would
 * put filesystem access in a pure reducer, so the impure edge — `src/operations/export-projection.ts`,
 * the one place that opens the run — reads and parses the payloads and hands them here. The "which
 * artifact is a runner report" filter did not disappear with the change of parameter; it moved there
 * with the read, as `runnerReportSources`, and got narrower on the way.
 *
 * **Excluded, not refused.** Unlike `report-mapping.ts`'s `mapObservedReport` -- which runs at
 * ingestion time and REFUSES the whole run on a malformed or ambiguous tag, because an ambiguous
 * identity there means the workspace cannot tell which registered case ran -- this join runs at
 * reporting time, over an ALREADY-ACCEPTED batch. A location is an annotation on a result that already
 * exists, never a gate on whether it exists, so an untagged spec, a spec whose tag does not parse, and
 * a spec whose file is missing or cannot be rebased onto `runRoot` are all silently excluded from the
 * map rather than raised as an error.
 *
 * **`runRoot` must be ABSOLUTE**, and is the directory a SARIF consumer resolves `artifactLocation.uri`
 * against — the `--root` the export was invoked with, which is the repository checkout in the pipeline
 * `README.md` documents. The one production caller passes `resolve(options.root)`. See
 * {@link runRootRelativeUri} for what each spec's `file` is rebased FROM, and for what a spec that
 * cannot be rebased costs.
 *
 * **A duplicate identity poisons the key only when the two occurrences DISAGREE.** Two specs claiming
 * the same identity from DIFFERENT places means this join cannot tell which one actually produced the
 * entry, and picking one is a guess wearing a file path -- worse than no location at all, because a
 * wrong location is indistinguishable from a right one to whoever reads it next.
 *
 * Two occurrences that agree are not that case, and treating them as one silently destroyed every
 * location for a shape that is ordinary rather than exotic. A run may hold SEVERAL Runtime-Observed
 * Executions -- `executeObservedPlaywright` mints a fresh `executionId` per invocation with no
 * uniqueness guard, and `tests/operations/export-projection.test.ts` registers two -- so re-executing
 * the same observed suite inside one run (a retry, or a second pass after a fix) hands this function two
 * sanitized reports over the SAME spec tree, carrying the same identity at the same file and the same
 * line. There is nothing to guess between them: they say the same thing. Under a has-key test the
 * whole map emptied, `unreadableRunnerReports` stayed empty, the export exited 0, and the SARIF was
 * indistinguishable from a run whose specs were never tagged. So the ambiguity test compares the
 * RESOLVED LOCATION, and only a genuine disagreement about `file` or `line` poisons the key.
 */
export function specLocationsByEntryIdentity(runRoot: string, runnerReports: readonly Readonly<Record<string, unknown>>[]): ReadonlyMap<string, ProjectionLocation> {
  const found = new Map<string, ProjectionLocation>();
  const ambiguous = new Set<string>();
  for (const report of runnerReports) {
    // Read once per REPORT, not per spec: `rootDir` is the report's own, and a run holding several
    // observed executions can hold several reports with different ones (a second suite under its own
    // Playwright config). Each report's specs rebase against that report's root.
    const config = isRecord(report.config) ? report.config : {};
    const rootDir = typeof config.rootDir === "string" && isAbsolute(config.rootDir) ? config.rootDir : undefined;
    for (const spec of collectSpecs(report.suites)) {
      const title = typeof spec.title === "string" ? spec.title : "";
      const file = runRootRelativeUri(runRoot, rootDir, spec.file);
      const match = identityTagPattern.exec(title);
      if (match === null || file === undefined) continue;
      // `?? ""` mirrors `report-mapping.ts`'s own `parseIdentityTag` (report-mapping.ts:140-142): the
      // pattern requires all four groups, so a successful match always populates them, but
      // `noUncheckedIndexedAccess` still types a capture group access as possibly `undefined`.
      const key = specLocationKey({ testCaseId: match[1] ?? "", testCaseRevisionId: match[2] ?? "", testCaseInstanceId: match[3] ?? "", executionSurface: match[4] ?? "" });
      // A POSITIVE INTEGER, not merely a number. `renderSarif` puts this straight into
      // `region.startLine`, which the official schema types `{"type": "integer", "minimum": 1}`
      // (verified in the vendored `fixtures/sarif/sarif-2.1.0-schema.json`), so `0`, `-3`, `1.5`, `NaN`
      // and `Infinity` each render a document that GitHub's code-scanning upload rejects outright --
      // the whole projection lost to one bad field. This value is the CONTENT of a registered binary,
      // which nothing schema-validates (`inspect-workspace-state.ts:324` returns before
      // `validateArtifact`), so this is the only place the constraint can be enforced.
      //
      // A bad line drops the LINE, never the location: the file is still a true location, and
      // discarding a correct fact because a neighbouring one is wrong would tell a reader less than the
      // run actually knows.
      const line = typeof spec.line === "number" && Number.isInteger(spec.line) && spec.line >= 1 ? spec.line : undefined;
      // Compared AFTER `line` is resolved, so the two sides being compared are the locations this
      // function would actually emit rather than the raw payload fields -- a spec whose `line` is `0`
      // and one whose `line` is absent both resolve to no line, agree, and must not read as a conflict.
      const existing = found.get(key);
      if (existing !== undefined) {
        if (existing.file !== file || existing.line !== line) ambiguous.add(key);
        continue;
      }
      found.set(key, line === undefined ? { file } : { file, line });
    }
  }
  for (const key of ambiguous) found.delete(key);
  return found;
}
