import type { AttemptRow, ProjectionModel } from "./projection-model.js";

/** One SARIF `result`. `locations` is present only when `observedResult` below actually joined one. */
type SarifResult = {
  ruleId: string;
  level: "error" | "warning";
  message: { text: string };
  locations?: readonly { physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } } }[];
};

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
 * A location is attached only when one was JOINED from the sanitized report. Everything else in this
 * file has no file position that exists, and inventing one — from change-scope, from a test case, from
 * anywhere — would assert more than the run knows.
 */
function observedResult(row: AttemptRow): SarifResult {
  const message = { text: `observed execution reported ${row.testCaseId} ${row.testCaseInstanceId} as ${row.status} (${row.failureClassification}) on the ${row.executionSurface} surface, provenance ${row.provenance}` };
  return row.location === undefined
    ? { ruleId: "observed-failure", level: "error", message }
    : { ruleId: "observed-failure", level: "error", message, locations: [{ physicalLocation: { artifactLocation: { uri: row.location.file }, ...(row.location.line === undefined ? {} : { region: { startLine: row.location.line } }) } }] };
}

/**
 * Renders a `ProjectionModel` as a SARIF 2.1.0 document. Pure function, no filesystem — the caller
 * decides where the string lands. Unlike `renderJUnit`, this renderer DOES carry `findings`: SARIF feeds
 * GitHub code scanning, which is exactly where an open bug, an unmet coverage obligation, an evidence
 * gap, and a failing gate rule belong, so all four surface here as `result`s.
 */
export function renderSarif(model: ProjectionModel): string {
  const results: SarifResult[] = [
    // A gate rule that PASSED has nothing to report — this is a projection of what is wrong, not a
    // restatement of the whole gate; JUnit already carries the full pass/fail record for every rule.
    ...model.gate.verdicts.filter((verdict) => !verdict.passed)
      .map((verdict) => ({ ruleId: verdict.rule, level: "error" as const, message: { text: verdict.reason } })),
    ...model.findings.map((finding) => ({ ruleId: finding.ruleId, level: finding.level, message: { text: finding.message } })),
    ...model.attempts.filter((row) => row.lane === "observed-entry" && row.status === "FAILED").map(observedResult),
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
  return `${JSON.stringify(sarif, null, 2)}\n`;
}
