# Phase 8a — CI export (JUnit + SARIF projections)

Design for the first half of Phase 8 in `docs/superpowers/plans/2026-07-24-production-readiness.md:106-108`.
Phase 8b — `retest`/`regression` as filters over both lanes, and `scaffoldWorkflowInput` emitting all six
modes (MODE-1) — is a separate branch with its own spec, and is not designed here.

Baseline: `main` @ `312a69d`, CI green on all three legs including Windows for the first time
(run 30450362518). Gate at that head: 1044/1044 tests (80 files), coverage 93.72/83.56/98.03/93.72 against
the 90/80/95/90 floor, `scan:secrets` over 307 tracked files, madge acyclic, `smoke:package` green.

## What exists already, and what does not

Verified this session, with citations, so no implementer re-derives it:

- **Nothing exists.** No occurrence of `junit` or `sarif`, case-insensitive, anywhere in `src/`, `tests/`,
  `shared/`, `skills/`, `docs/`, or `README.md`.
- **CI already fails on `NOT_READY`.** `src/cli/exit-codes.ts:39` maps `releaseRecommendation ===
  "NOT_READY"` to `UNMET_OBLIGATIONS` (1), and `program.ts:130` applies it to `workflow run`. Phase 8a adds
  the files a pipeline reads; it does not add the failure.
- **`WorkflowResult` carries `runId`** (`src/operations/run-workflow.ts:88`), and `workflow run` prints the
  whole result as JSON (`program.ts:129`). CI can therefore capture the run id with `jq -r .runId`. There is
  no gap here, and no reason to add a `--run-id latest`: `workflow.ts:64` states the deliberate rule that the
  CLI never discovers a "latest" run.
- **The report already reads both lanes.** `src/operations/generate-qa-report.ts:42` flattens
  `test-result-batch` entries alongside `test-result`. The lane-1-only wart recorded in the Phase 7 handoff
  was closed when the producer landed.
- **A finalized run is opened with `RunWorkspace.open(root, runId)`** — the shape `validate` already uses at
  `program.ts:267`.
- **A lane-2 entry carries no file path.** `shared/schemas/test-result-batch.schema.json` entry properties
  are `entryId`, `testCaseId`, `testCaseRevisionId`, `testCaseInstanceId`, `status`, `failureClassification`,
  `executionSurface`, `steps`, `evidenceArtifactIds`, plus `observedEngine`/`viewport` on the `browser`
  surface only. No path, no line.
- **The path exists in the sanitized evidence.** `src/observed/sanitize-report.ts:67-68` keeps `title`,
  `file`, `line`, `column` for both suites and specs, because the line it draws is committed spec-tree
  content versus run-time output.
- **Tests use no snapshots.** Zero `toMatchSnapshot`/`toMatchInlineSnapshot` in `tests/`.
- **Dependencies:** `ajv` and `ajv-formats` are already runtime dependencies. No XML parser is present.

## Decisions

Each was taken by the user during brainstorming; the reasoning is recorded so it is not relitigated.

1. **Phase 8 splits into 8a (export) and 8b (filters + six modes),** two branches, two whole-branch reviews.
   Mirrors the Phase 7 habit of landing a reviewable unit before the thing that consumes it.
2. **The projections are derived files with a provenance sidecar, not registered artifacts.** They are
   written outside the run workspace and never enter the manifest. A bare derived file would be a
   self-certifying channel — a hand-edited XML handed to CI would be indistinguishable from a real one —
   which is the shape this project rejects elsewhere. A new registered `artifactType` was rejected instead
   because XML has no place in a JSON artifact system, and because a finalized run is closed: writing into it
   after the gate is snapshotted has no defined semantics.
3. **JUnit carries two suites in one file:** the gate's rule verdicts, and the run's attempts. A CI operator
   needs both the reason the gate is red and the tests that ran; a gate-only file loses the second, and an
   attempts-only file hides a `NOT_READY` caused by unmet coverage.
4. **SARIF attaches a location only when a real one exists, and omits it otherwise.** Never fabricates one.
   Deriving locations from `change-scope` was rejected: its `provenance.kind: "git-diff"` is a
   caller-asserted label that nothing verifies, so a location built on it would assert more than the system
   knows.
5. **Under `protectedEnvironment`, the projections are reduced rather than refused.** Identifiers, statuses,
   severities, surfaces and counts survive; free text authored by an agent or captured from telemetry does
   not. A `--allow-protected` escape hatch was rejected for the same reason Phase 7 rejected `--allow-dirty`:
   a flag relocates responsibility without reducing the risk.
6. **Export is its own command reading a finalized run,** not a flag on `workflow run`. It can re-project any
   past run, and it keeps the projection code testable without going through orchestration or a browser.
7. **SARIF output is validated against the official SARIF 2.1.0 JSON Schema, vendored into `fixtures/` and
   checked with the ajv already present. JUnit is checked with explicit string assertions.** No new
   dependency. JUnit has no authoritative schema worth pinning to; SARIF does, and a SARIF file that is
   invalid against it fails outside our test boundary — at GitHub's upload — which is the worst place to find
   out.

## Architecture

New module `src/reporting/projections/`, all pure, no filesystem, no workspace types:

| File | Responsibility |
| --- | --- |
| `projection-model.ts` | Reduce already-read artifacts to a `ProjectionModel` |
| `junit.ts` | `(ProjectionModel) => string` (XML) |
| `sarif.ts` | `(ProjectionModel) => string` (JSON) |
| `sidecar.ts` | `(ProjectionModel, bytes) => string` (JSON provenance) |

One impure edge, `src/operations/export-projection.ts`: opens the workspace, reads artifacts, builds the
model, renders, writes the projection and its sidecar. One CLI command in `src/cli/program.ts`.

The boundary earns its keep three ways: the renderers are testable by table with no workspace; a third format
later is one new file and no change to the edge; and the model is the single place that decides what a
projection may see, so the reduced mode is enforced once rather than per format.

### `ProjectionModel`

```ts
type ProjectionModel = Readonly<{
  runId: string;
  producerVersion: string;              // dynamic runtimeVersion, not a literal
  generatedAt: string;
  reduced: boolean;                     // mirrors protectedEnvironment
  gate: Readonly<{ artifactId: string; sha256: string; recommendation: ReleaseRecommendation;
                   verdicts: readonly RuleVerdict[]; ruleInputs: ReleaseGateInput }>;
  attempts: readonly AttemptRow[];      // both lanes, already flattened
  findings: readonly FindingRow[];      // bugs, coverage gaps, evidence gaps
  anchor?: Readonly<{ commitSha: string; specTreeSha256: string }>;  // present when a batch exists
  sourceArtifacts: readonly GateSourceArtifact[];
}>;
```

`AttemptRow` carries `testCaseId`, `testCaseInstanceId`, `status`, `failureClassification`,
`executionSurface`, `durationMs`, and an optional `location` (`{ file, line }`). `FindingRow` carries a
`ruleId`, a `level`, an identifier, and an optional message that the reduced mode drops.

The two formats read different parts of the model, deliberately: JUnit reads `gate.verdicts` and `attempts`
and **ignores `findings`**; SARIF reads `gate.verdicts`, `findings`, the failing subset of `attempts`, and
`anchor`. A third JUnit suite for findings is not wanted — bugs and coverage gaps are not test cases, and
naming them as such is the kind of overclaim the gate exists to prevent.

**Do not add a second gate derivation.** The persisted `release-gate` artifact is the gate. Whatever binding
verification `RunWorkspace.open` already performs is the verification; export reuses it. Two derivation paths
that can disagree is the exact failure mode recorded against `VALID_ARTIFACTS`, where a persisted gate would
permanently mismatch its own re-derivation and be unrecoverably flagged.

## JUnit projection

Suite `qa-skills.gate`: one `<testcase name="<rule>" classname="gate"/>` per `RuleVerdict`; a verdict with
`passed: false` gets `<failure message="<reason>"/>`. Nothing else goes in this suite.

Suite `qa-skills.attempts`: one `<testcase>` per lane-1 `test-result` and per lane-2 batch entry.

| Attribute / element | Source |
| --- | --- |
| `name` | `${testCaseId} ${testCaseInstanceId}` |
| `classname` | `executionSurface` for a lane-2 entry; for lane 1, see the verification list |
| `time` | sum of `steps[].durationMs / 1000` — a batch entry has no timestamps of its own, only the batch does |
| `FAILED` | `<failure message="failureClassification=<value>"/>` |
| `BLOCKED`, `INCONCLUSIVE` | `<error message="status=<value>"/>` |
| `NOT_RUN` | `<skipped/>` |
| `PASSED` | no child element |

The `tests`, `failures`, `errors` and `skipped` attributes are counted from the rows, never written by hand.
Every emitted text is XML-escaped (`&`, `<`, `>`, `"`, `'`) with its own test.

## SARIF projection

SARIF 2.1.0, one `run`, `tool.driver.name = "qa-skills"`, `driver.version` = the dynamic runtime version.

| `ruleId` | Source | `level` |
| --- | --- | --- |
| the gate rule's own name | a failing `RuleVerdict` | `error` |
| `open-bug` | an open bug | `error` for `Blocker`/`Critical`, else `warning` |
| `required-coverage-unmet` | `ruleInputs.coverage.requiredMissing` | `error` |
| `optional-coverage-gap` | `ruleInputs.coverage.optionalGaps` | `warning` |
| `observed-failure` | a lane-2 entry with `status: FAILED` | `error` |
| `evidence-gap` | an `evidence-gap` artifact | `warning` |

`automationDetails.id` is the `runId`. When the run has a `test-result-batch`,
`versionControlProvenance[].revisionId` is its `commitSha` — SARIF has a field for exactly the anchor lane 2
already proves, so populating it asserts nothing new.

**Locations.** Only `observed-failure` can have one, and only by the join: entry → `evidenceArtifactIds` →
sanitized report payload → the spec whose title carries the identity tag
`[qa:<testCaseId>/<revisionId>/<instanceId>@<surface>]` matching the entry → `file` and `line`. Phase 7
attaches evidence to failing cases, which is the case SARIF wants, so the join is usually available; when it
is not, the result is emitted with no `locations` array rather than with a guessed one. Every other rule id
above is emitted without a location, always.

## Reduced mode

When the gate reports `protectedEnvironment: true`, `projection-model.ts` builds the model with `reduced:
true` and drops every free-text string authored by an agent or captured from telemetry: bug titles and
descriptions, evidence-gap reasons, telemetry finding text. It keeps identifiers, statuses, severities,
surfaces, and counts.

SARIF requires `message.text` on a result, so a reduced message is composed from identifiers — for example
`open bug BUG-014, severity Critical` — rather than left empty. The sidecar records `reduced: true`, so a
consumer can tell a reduced projection from a full one without guessing from its contents.

## Sidecar

Written next to the projection as `<out>.provenance.json`:

```json
{
  "projection": "junit",
  "projectionSha256": "<sha256 of the bytes just written>",
  "runId": "...",
  "gate": { "artifactId": "...", "sha256": "...", "recommendation": "NOT_READY" },
  "sourceArtifacts": [{ "id": "...", "sha256": "...", "type": "test-result-batch" }],
  "protectedEnvironment": true,
  "reduced": true,
  "producerVersion": "<dynamic runtimeVersion>",
  "generatedAt": "..."
}
```

Export never writes inside `qa-results/<runId>/`. The run is closed; the sidecar lives beside the output.

## CLI and exit codes

```
qa-skill export --root <path> --run-id <id> --format junit|sarif --out <path>
```

Exit `SUCCESS` (0) when the projection is written, **including when the gate is `NOT_READY`**. Folding the
gate verdict into export's exit code would give one code two meanings, and `workflow run` already carries
that meaning. Exit `INVALID_INPUT` (3) when the run does not exist, the run has no `release-gate` artifact
(it was never finalized), the format is unrecognized, or `--out` cannot be written. No new exit code is
added; `src/cli/exit-codes.ts` keeps its six.

`producerVersion` is read from the runtime version rather than hardcoded — the repo already carries 24
hardcoded `producerVersion` literals as filed debt, and this adds none.

## README GitHub Actions example

The example must show `if: always()` on every export and upload step. `workflow run` exits 1 on `NOT_READY`,
so without it the pipeline loses its projections in exactly the case they are needed, and the failure is
silent. The job is failed by an explicit final step reading the run step's `outcome`, so the reader can see
where the red comes from.

```yaml
- id: qa
  continue-on-error: true
  run: npx qa-skill workflow run --input workflow-input.json | tee qa-run.json
- if: always()
  run: |
    RUN_ID=$(jq -r .runId qa-run.json)
    npx qa-skill export --root . --run-id "$RUN_ID" --format junit --out qa-junit.xml
    npx qa-skill export --root . --run-id "$RUN_ID" --format sarif --out qa.sarif
- if: always()
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: qa.sarif
- if: steps.qa.outcome == 'failure'
  run: exit 1
```

`recovery.md` gains the export command and its exit codes; the skill bundle reference gains the same, so an
agent reading only the bundle can produce CI artifacts.

## Testing

- **Renderers, by table.** One row per status, per level, per rule id. XML escaping has its own case. Suite
  counting has its own case. Reduced mode has its own case per format.
- **SARIF against the vendored schema,** using the ajv already present.
- **The edge, through the real CLI** against a finalized run workspace — including the two refusals (no run,
  no gate) and the sidecar's `projectionSha256` matching the bytes actually written.
- **Every test proves itself by mutation:** delete the line it covers and watch it red, before it is
  accepted. Phase 6 shipped four tests that passed with the feature removed; the habit that caught them is
  the habit here.
- The full gate is **eight commands plus `smoke:package`**, run from a deleted `dist/` — the correction Task
  42 paid for, recorded in `.superpowers/sdd/progress.md` under TASK 42. `npm run scan:secrets` is one of the
  eight, and was the one missing from every brief before that task; the deleted `dist/` is the second half of
  the same correction, because a CI runner checks out clean and a local machine does not. Take the command
  list from `.github/workflows/ci.yml`, not from memory.

## Must verify before implementing

Not assumptions to code against — measurements to take first:

1. **Lane 1's `classname`.** A `test-result` has no `executionSurface`. Determine what lane 1 can honestly
   report, and if it is browser-only, say so from the code rather than from this document.
2. **Gate verdict `reason` composition.** Check every branch of `evaluateReleaseGate`. If a reason embeds
   only identifiers it survives the reduced mode unchanged; if any branch embeds artifact-authored text, the
   reduced mode must recompose it. Do not generalize from one branch.
3. **What `RunWorkspace.open` verifies.** If it already checks artifact binding, export reuses it and adds
   nothing. If it does not, decide deliberately and record the decision — do not quietly add a second
   derivation.
4. **GitHub's handling of a SARIF result with no `locations`.** Measure it against a real upload. If such
   results are dropped from the UI, that is a documentation obligation, not a reason to fabricate locations.
5. **The vendored SARIF schema's size and licence** before committing it.

## Out of scope

- Phase 8b: `retest`/`regression` filters, `scaffoldWorkflowInput` emitting `charter`/`retest`/`changeScope`.
- Registering projections as artifacts, or any write into a finalized run.
- A third export format.
- The filed carry-forward items, none of which this branch touches: `VALID_ARTIFACTS`'s dead second parameter
  (delete the parameter, never start passing it), the 24 hardcoded `producerVersion` literals, C8's missing
  CLI-level test for `OBSERVED_RUN_SPEC_LOCATION_UNKNOWN`, the unpinned size-preserving `clean`-filter
  counterexample, and the uncommented `sk-live-planted` fixtures that survive `scan:secrets` only because
  their 12-character tail is under the 16-character minimum.
