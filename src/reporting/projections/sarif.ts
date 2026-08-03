import type { AttemptRow, ProjectionModel } from "./projection-model.js";

/** One SARIF `result`. `locations` is present only when `observedResult` below actually joined one. */
type SarifResult = {
  ruleId: string;
  level: "error" | "warning";
  message: { text: string };
  locations?: readonly { physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } } }[];
};

/**
 * One `AttemptRow.location.file` — a run-root-relative POSIX PATH — spelled as a SARIF
 * `artifactLocation.uri`.
 *
 * **Measured, not assumed** (vendored `fixtures/sarif/sarif-2.1.0-schema.json`, this repo's own `ajv` +
 * `ajv-formats`, `strict: false`): copied across verbatim, `e2e/check out.spec.ts`,
 * `e2e/テスト.spec.ts`, `e2e/100%-done.spec.ts` and `e2e/a[1].spec.ts` each FAIL
 * `artifactLocation.uri`'s `format: "uri-reference"`, and that failure lands outside this repo's test
 * boundary — at GitHub's upload, which rejects the WHOLE document over one filename while
 * `qa-skill export` exits 0 and the sidecar certifies the rejected bytes.
 *
 * **`encodeURIComponent` PER SEGMENT, and `encodeURI` would be wrong.** `encodeURI` leaves `#`, `?` and
 * `&` alone, which is the half the schema cannot see: `e2e/a#b.spec.ts` is a schema-VALID uri-reference
 * (measured `valid: true`) naming the file `e2e/a` with fragment `b.spec.ts`, and `?` opens a query the
 * same way. A wrong location is worse than none, because a reader cannot tell it from a right one — the
 * same reason `spec-locations.ts` refuses a `file` it cannot rebase. Splitting on `/` first keeps the
 * separator a separator, and everything `encodeURIComponent` leaves unescaped (`A-Za-z0-9-_.!~*'()`) is
 * a valid RFC 3986 `pchar` — so every segment it produces is a legal one.
 *
 * Legal is not the same as inert, and exactly one class shows the difference: `.` and `..` are spelled
 * entirely in unreserved characters, so they survive encoding untouched and are then resolved away as
 * DOT SEGMENTS by whoever reads the URI (measured: `e2e/../secret.spec.ts` emits unchanged and resolves
 * to `/repo/secret.spec.ts` — a different file, the same defect class as `#`, and invisible to a schema
 * check). This function does not strip them; `spec-locations.ts` does, because `resolve()` normalizes
 * every dot segment away before `manifestRelativePath` ever sees the path. That is a real dependency on
 * the producer, recorded here so it cannot be broken silently from the other side.
 *
 * **Double-encoding is the risk in the other direction, and the input shape is what rules it out.** A
 * file literally named `100%-done.spec.ts` must reach `100%25-done.spec.ts` and decode back — it does,
 * and the URI test pins it. It cannot be encoded TWICE because the value arriving here is always a
 * filesystem path and never a URI: `spec-locations.ts`'s `runRootRelativePath` is the only producer of a
 * `ProjectionLocation`, and it builds `file` from `resolve()` + `manifestRelativePath()` — path
 * arithmetic, which percent-decodes nothing and percent-encodes nothing. If a spec really is named
 * `check%20out.spec.ts` on disk, `check%2520out.spec.ts` is the CORRECT URI for it. Keeping
 * `location.file` a decoded path (see its TSDoc) is what makes that invariant local enough to state.
 *
 * **No second separator decision.** `location.file` is `/`-separated on EVERY platform because
 * `manifestRelativePath` already converted it — on `win32` it splits on `\` and joins with `/`
 * (`core/fs.ts`), so nothing here re-derives that. Splitting on `/` reads that contract rather than
 * competing with it, and a literal backslash — legal in a POSIX filename, impossible in a Windows one —
 * is correctly escaped to `%5C` rather than mistaken for a separator.
 *
 * **A leading `/` or a drive letter cannot arrive**, and the containment check is the ONLY thing making
 * that true: `isPathWithin` rejects a relative result that `isAbsolute`, so `manifestRelativePath` only
 * ever returns a contained relative path. This function does not re-derive that and cannot repair it —
 * measured, the two halves behave differently if one ever slips through. A drive letter degrades safely
 * (`C:/x` → `C%3A/x`, still a relative-path reference rather than a `C:` scheme), but a LEADING `/`
 * does not: its empty first segment encodes to empty, so `/e2e/a.spec.ts` emits unchanged and resolves
 * at the origin root, dropping the repository base entirely. Stated because the earlier version of this
 * comment claimed a fallback that only ever held for the drive letter.
 *
 * **TOTAL: this function never throws, and that is a separate guarantee from truth.** `encodeURIComponent`
 * throws `URIError` on an unpaired UTF-16 surrogate, which is unencodable as UTF-8 and therefore
 * unspellable as any URI. `spec-locations.ts` already refuses to emit such a location — TRUTH is its
 * guarantee, asked and answered fail-closed — while THIS function's guarantee is only that it always
 * returns. Measured before the fix: the throw escaped through `program.ts`'s final `else` as the bare
 * string `URI malformed` at exit `ABORTED_OR_INTERNAL`, naming no spec file and no artifact — an
 * internal error where the truth was a data problem.
 *
 * **Stated precisely: this branch is UNREACHABLE IN PRODUCTION AS SHIPPED, not defence in depth.**
 * `runRootRelativePath` is the only thing in `src/` that constructs a `ProjectionLocation`, it guards
 * the fully REBASED path, and `export-projection.ts` holds the only call to `renderSarif`. Nor can an
 * outside consumer reach it: the package `exports` map publishes exactly `.` and `./cli` with no
 * wildcard subpath, so "any caller can construct a `ProjectionModel`" is true only of IN-REPO callers.
 * It is a real totality contract rather than dead code — deleting it is killed by test, and it is what
 * keeps a weakened producer (one guarding raw `spec.file`, which a surrogate living in `config.rootDir`
 * never touches) from turning a data problem back into a crash — but a reader deserves to know that no
 * production path exercises it today.
 *
 * `undefined` — omit the location — rather than `junit.ts`'s neutralize-to-`\uFFFD`, and the two are NOT
 * in conflict. (`renderJUnit` surviving the identical model is no evidence either way: it never reads
 * `location` at all, so it survives by never looking, not by neutralizing.) `escapeXml` neutralizes
 * because the field it guards is MANDATORY: a `<testcase>` must
 * carry a `name`, XML has no way to spell "no name", and dropping the element would lose a whole result,
 * so it accepts local damage to keep the record. SARIF's `locations` is OPTIONAL — this file already
 * omits it for every row that joined nothing, and `projection-model.ts` states the rule: a location is
 * an annotation on a result that already exists, never a gate on whether it exists. So SARIF can decline
 * to spell the location and still keep the failure, where JUnit could not. `%EF%BF%BD` would be a URI
 * naming a file that does not exist — the fabrication this whole module refuses. One rule, preserve the
 * result and never invent, applied to fields with different obligations.
 */
const artifactUri = (file: string): string | undefined =>
  (file.isWellFormed() ? file.split("/").map(encodeURIComponent).join("/") : undefined);

/**
 * One SARIF result for an observed (lane-2) FAILED attempt.
 *
 * The message unconditionally names the row's own `provenance` — a controller decision that is NOT in
 * the brief, but is required to keep this projection consistent with Task 3's JUnit renderer. Task 3
 * established the rule this file must also follow: a projection never filters on provenance
 * (`generate-qa-report.ts:39-41` — a projection is a REPORT, and a report "describes what the run
 * recorded rather than what earned credit"), because the coverage readers, not this reducer, are the
 * ones that decide what earns credit (`creditsCoverage`, `src/core/provenance.ts`). But a projection
 * leaves the artifact system — where `record.provenance` is visible on every claim — for a CI service
 * where it is not, so the anomalous row must still be MARKED, not dropped. JUnit marks it by prefixing
 * the testcase name; SARIF has no field of its own for provenance, so this file uses the one field every
 * result already carries, `message.text`.
 *
 * The name is included UNCONDITIONALLY — for a crediting `runtime-observed`/`runtime-execution` row
 * exactly as for a non-crediting `agent-draft` one — because a message that names the provenance only
 * sometimes teaches a CI reader nothing when it is absent: silence would be ambiguous between "this row
 * credits coverage" and "this renderer simply didn't say." Naming it every time removes that ambiguity,
 * which is why this function needs no `creditsCoverage` branch at all.
 *
 * A location is attached only when one was JOINED from the sanitized report AND `artifactUri` can spell
 * it. Everything else in this file has no file position that exists, and inventing one — from
 * change-scope, from a test case, from anywhere — would assert more than the run knows. The two reasons
 * to carry no location are deliberately indistinguishable in the output: both mean "this run cannot say
 * where", which is the whole claim a reader needs.
 */
function observedResult(row: AttemptRow): SarifResult {
  const message = { text: `observed execution reported ${row.testCaseId} ${row.testCaseInstanceId} as ${row.status} (${row.failureClassification}) on the ${row.executionSurface} surface, provenance ${row.provenance}` };
  const result: SarifResult = { ruleId: "observed-failure", level: "error", message };
  if (row.location === undefined) return result;
  const uri = artifactUri(row.location.file);
  if (uri === undefined) return result;
  const { line } = row.location;
  return { ...result, locations: [{ physicalLocation: { artifactLocation: { uri }, ...(line === undefined ? {} : { region: { startLine: line } }) } }] };
}

/**
 * A rendered SARIF document, and how many of the observed failures in it name no source location.
 *
 * The count is reported ALONGSIDE the bytes rather than re-derived by the caller, and that is the whole
 * point of returning it here: `observedResult` above has two independent reasons to omit a location and
 * declares them indistinguishable in the output, so a caller asking the model the same question would be
 * a second derivation of a decision this file already made — and could only ever agree, or disagree and
 * be wrong. Counted over the OBSERVED results alone: a gate verdict and a finding are not file positions
 * that failed to resolve, they are facts about the run that have no file, so folding them in would make
 * the number non-zero for every export and mean nothing.
 */
export type SarifProjection = Readonly<{ document: string; observedResultsWithoutLocation: number }>;

/**
 * Renders a `ProjectionModel` as a SARIF 2.1.0 document. Pure function, no filesystem — the caller
 * decides where the string lands. Unlike `renderJUnit`, this renderer DOES carry `findings`: SARIF feeds
 * GitHub code scanning, which is exactly where an open bug, an unmet coverage obligation, an evidence
 * gap, and a failing gate rule belong, so all four surface here as `result`s.
 */
export function renderSarif(model: ProjectionModel): SarifProjection {
  const observed = model.attempts.filter((row) => row.lane === "observed-entry" && row.status === "FAILED").map(observedResult);
  const results: SarifResult[] = [
    // A gate rule that PASSED has nothing to report — this is a projection of what is wrong, not a
    // restatement of the whole gate; JUnit already carries the full pass/fail record for every rule.
    ...model.gate.verdicts.filter((verdict) => !verdict.passed)
      .map((verdict) => ({ ruleId: verdict.rule, level: "error" as const, message: { text: verdict.reason } })),
    ...model.findings.map((finding) => ({ ruleId: finding.ruleId, level: finding.level, message: { text: finding.message } })),
    ...observed,
  ];
  // `rules` de-duplicates by ruleId so the same finding kind or gate rule isn't declared twice when it
  // fires more than once in one run.
  const ruleIds = [...new Set(results.map((result) => result.ruleId))];
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      // `model.producerVersion`, not the imported `runtimeVersion`. Identical in production — the one
      // production caller passes `runtimeVersion` in — but the sidecar records `model.producerVersion`
      // for these same bytes, so reading the version from anywhere else is a surface on which the
      // document and the sidecar that vouches for it could disagree, with nothing gained.
      tool: { driver: { name: "qa-skills", version: model.producerVersion, informationUri: "https://github.com/dangnhit/qa-tester", rules: ruleIds.map((id) => ({ id })) } },
      automationDetails: { id: model.runId },
      // `versionControlProvenance` is NOT used, even though it is SARIF's named field for exactly this
      // fact. Its item type, `versionControlDetails`, REQUIRES `repositoryUri` (format: uri, non-empty)
      // -- verified by compiling the vendored schema, not assumed: both `repositoryUri: ""` and omitting
      // `repositoryUri` while keeping only `revisionId` fail validation (the latter with "must have
      // required property 'repositoryUri'"). `ProjectionModel` carries no repository URL anywhere -- not
      // on `anchor`, not on any artifact -- and this renderer reads no filesystem or git to find one, so
      // there is no honest value for that required field.
      //
      // But `commitSha`/`specTreeSha256` ARE facts the run verified -- the lane-2 git anchor, re-resolved
      // after the runner exits and the run refused if the spec tree moved (ADR-0010) -- so dropping them
      // entirely would repeat, in the other direction, the exact mistake `observedResult` above exists to
      // avoid marking rather than dropping an anomalous provenance. `run.properties` is SARIF's own
      // propertyBag (`additionalProperties: true`), the sanctioned home for a verified fact with no clean
      // named field; an unrecognized property is inert to a consumer that does not look for it.
      //
      // Emitted only when `model.anchor` exists, and `buildProjectionModel`'s `agreedAnchor` is what
      // decides that: a run with no observed execution has no verified revision, and a run whose several
      // executions resolved DIFFERENT revisions has no single one either. The bag stands over every
      // result in this document, so a value true of only some of them would be exactly the fabrication
      // this task exists to avoid — as would an empty or zero-filled one.
      ...(model.anchor === undefined ? {} : { properties: { commitSha: model.anchor.commitSha, specTreeSha256: model.anchor.specTreeSha256 } }),
      results,
    }],
  };
  return {
    document: `${JSON.stringify(sarif, null, 2)}\n`,
    // Read off the results this render actually emitted, not recomputed from `model.attempts`: the
    // `artifactUri` half of the omission is not visible on the model at all.
    observedResultsWithoutLocation: observed.filter((result) => result.locations === undefined).length,
  };
}
