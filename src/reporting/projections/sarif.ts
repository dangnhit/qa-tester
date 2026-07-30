import { runtimeVersion } from "../../installer/manifest.js";
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
      tool: { driver: { name: "qa-skills", version: runtimeVersion, informationUri: "https://github.com/dangnhit/qa-tester", rules: ruleIds.map((id) => ({ id })) } },
      automationDetails: { id: model.runId },
      // No `versionControlProvenance` here — see the long comment this decision earned in
      // `sarif.test.ts`'s "never invents a repository location" test. In short: the SARIF schema
      // requires `versionControlDetails.repositoryUri` (format: uri, non-empty), `ProjectionModel`
      // carries no repository URL anywhere, and this renderer does not read the filesystem or git to
      // find one — so there is no value here that would not misdescribe whichever repository a CI
      // consumer is actually scanning. The brief's fallback (`{ revisionId: ... }` alone, no
      // `repositoryUri`) was tried and FAILS the official schema too: `repositoryUri` is REQUIRED, so
      // omitting it is exactly as invalid as `repositoryUri: ""`. The schema is the authority, not the
      // plan, and what it actually requires here cannot be honestly supplied from this model.
      results,
    }],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}
