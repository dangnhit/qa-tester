# QA Skills

QA Skills is a portable, deterministic quality-assurance runtime for Codex, Claude Code, and Cursor. It combines versioned artifact contracts, a TypeScript CLI, a Playwright Runtime Browser Driver, evidence and defect operations, release-gate reporting, and one canonical cross-agent Skill Bundle.

The runtime never calls an LLM. Agents may author requirement and testcase drafts, while QA Skills validates, registers, executes, and reports immutable canonical artifacts.

## Requirements

- Node.js 22 or 24
- npm
- A locally installed Chromium binary for browser execution

QA execution never downloads a runtime or browser implicitly.

## Install and verify

From a checkout:

```bash
npm ci
npm run build
npx playwright install chromium
node dist/src/cli/index.js runtime verify --range ">=0.1.0 <1.0.0"
```

For a consuming project, install this package from a pinned local path or approved registry version, then use `node_modules/.bin/qa-skill`. Do not use a remote `npx` fallback during QA execution.

Initialize a project:

```bash
qa-skill init
```

This creates `qa.config.yaml` if absent and ensures `qa-results/` is ignored. The minimal config is:

```yaml
version: 1
```

Project configuration and Test Data Hooks must be reviewed source files. Store only Secret References in inputs; resolve secret values in memory at execution time.

## Deterministic demo

```bash
npm ci
npx playwright install chromium
npm run demo
```

The demo binds an ephemeral `127.0.0.1` port and makes no external request. Its fixture deliberately leaves an authoritative validation message empty, emits `QA_DEMO_CONSOLE_ERROR`, and calls a local endpoint that deterministically fails. The runtime executes Chromium desktop and emulated mobile Test Case Instances, records traces, sanitized raw and annotated screenshots, console/network telemetry, product Bug Candidates, a QA report, and a validated Full Artifact Profile. It also creates one owned synthetic Test Resource and proves its lifecycle through a separate linked Cleanup Run.

The command exits `0` only when the intentional defect is detected as `FAILED + PRODUCT_DEFECT`, the QA Run is `COMPLETED_WITH_FAILURES`, the release recommendation is `NOT_READY`, each desktop/mobile attempt has its required evidence, cleanup completes, and all expected artifacts validate. Canonical run data is written under `qa-results/`; convenient copied evidence projections are written under `demo-artifacts/`. Both are ignored.

## CLI reference

Commands that produce output use machine-readable JSON unless noted. Successful `qa-skill init` and `qa-skill artifact ingest` are intentionally silent on stdout.

| Command | Purpose |
| --- | --- |
| `qa-skill --version` | Print the installed package version. |
| `qa-skill init` | Create minimal project config and ignore `qa-results/`; success has no stdout. |
| `qa-skill skills list` | List the orchestrator and standalone Skill Adapters with execution kinds. |
| `qa-skill skills install --agent <codex\|claude\|cursor> [--target project\|user]` | Install a checksummed copy of the canonical Skill Bundle. |
| `qa-skill skills verify --agent ...` | Detect installed-file drift plus typed `runtime-missing`, `runtime-changed`, or `runtime-incompatible` Runtime Binding failures. |
| `qa-skill skills update --agent ... [--force]` | Refresh an installation; drift is preserved unless force is explicit. |
| `qa-skill skills uninstall --agent ...` | Remove owned unchanged files and report drift leftovers. |
| `qa-skill runtime verify [--range <semver>]` | Verify the local runtime binding and compatibility. |
| `qa-skill schema show --type <type>` | Print the compiled JSON Schema for an artifact type. |
| `qa-skill draft init --type <type>` | Print a minimal valid draft skeleton for one of the 4 agent-authored artifact types (`requirement-analysis`, `test-plan`, `test-case`, `coverage-obligation`); other types error as runtime-owned. |
| `qa-skill fingerprint --file <json>` | Print the sha256 content fingerprint of a JSON file; matches a registered `test-case`'s `revisionId`. |
| `qa-skill run create --root <path> --mode <profile> --environment-file <json>` | Create an unlocked, nonterminal Run Workspace for standalone specialist skills and return its run ID as JSON. |
| `qa-skill workflow bootstrap --root <path> --environment-file <json> --requirement-file <json> --plan-file <json> --test-case-file <json> --coverage-file <json>` | Atomically create the first complete terminal planning run and return its checksum-bound bundle reference; repeat testcase and coverage options as needed. |
| `qa-skill workflow scaffold --root <path> --mode <mode> --output <json> [--environment-file <json>] [--source-root <path> --source-run-id <id>] [--charter-file <json>] [--change-scope-file <json>] [--bug-run-id <id> [--bug-artifact-id <id>]] [--observed-execution] [--resume-run-id <id>]` | Create a closed workflow input using explicit checksum-bound sources; the charter/change-scope/bug options reach `exploratory`/`regression`/`retest`, and the last two drive the pause-and-resume flow below. See [Filtered runs over both lanes](#filtered-runs-over-both-lanes) and the [recovery reference](skills/shared/references/recovery.md#workflow-scaffolds-optional-inputs-and-what-refuses-each-one) for every refusal. |
| `qa-skill workflow run --input <json>` | Run the closed public QA Tester workflow with local runtime services. |
| `qa-skill artifact ingest --root <path> --run-id <id> --type <type> --file <json-or-yaml> [--relationship <id>]` | Validate and register an Agent Draft as a Canonical Artifact; success has no stdout. |
| `qa-skill execute playwright --root <path> --run-id <id> --spec-dir <path> [-- <runner args>]` | Start the project's own committed Playwright suite as a Runtime-Observed Execution and register one `test-result-batch` plus its sanitized runner report as evidence. Everything after `--` reaches the runner verbatim; `--reporter` and `--output` are runtime-owned and refused. |
| `qa-skill approval record --root <path> --run-id <id> --plan-artifact-id <id> --approved-by <identity>` | Persist an immutable human approval bound to the exact pending plan checksum. |
| `qa-skill attestation record --root <path> --run-id <id> --obligation-id <id> --method <keyboard\|screen-reader\|cognitive-manual> --attested-by <identity> --statement <text>` | Persist a person's immutable Human Attestation that a manual accessibility evaluation was carried out, bound to the exact obligation checksum. An agent cannot author one. |
| `qa-skill validate --root <path> --run-id <id> [--profile <name>]` | Reopen and validate checksums, relationships, schemas, and an optional Artifact Profile. |
| `qa-skill export --root <path> --run-id <id> --format <junit\|sarif> --out <path>` | Project a finalized run's release gate into a JUnit XML or SARIF 2.1.0 file for CI, writing a provenance sidecar to `<out>.provenance.json`. See [Consuming the gate in CI](#consuming-the-gate-in-ci). |

Public workflow modes are `plan`, `execute`, `full`, `exploratory`, `retest`, and `regression`. `cleanup` is a linked maintenance-run profile created through the cleanup operation; it is not accepted by the public workflow runner.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Command completed; for the demo, the expected defect and artifacts were detected. |
| `1` | Validation, installation, cleanup, or coverage obligations remain unmet. |
| `2` | A live lock or other recoverable blocker prevented progress. |
| `3` | Input, schema, profile, command, or compatibility data is invalid. |
| `4` | A path, symlink, installer, environment, or side-effect safety rule denied the action. |
| `5` | Execution aborted or an internal failure occurred. |

## Consuming the gate in CI

`qa-skill export --root <path> --run-id <id> --format junit|sarif --out <path>` projects a **finalized**
run's persisted release gate into a JUnit XML or a SARIF 2.1.0 file, writes a provenance sidecar to
`<out>.provenance.json`, and prints a JSON result (`format`, `outPath`, `sidecarPath`,
`projectionSha256`, `recommendation`, `reduced`, `unreadableRunnerReports`, and — for `sarif` only —
`observedResultsWithoutLocation`) to stdout. It exits `0` on
success — **including when `recommendation` is `NOT_READY`** — because exporting itself succeeded; the
verdict travels in the projection and the sidecar, never in this exit code. Refusals exit `3`, and that
includes a `--root` or `--run-id` that does not exist. The full breakdown is in
[`recovery.md`](skills/shared/references/recovery.md#qa-skill-export).

A minimal pipeline that runs the gate and always uploads its projections:

```yaml
- id: qa
  continue-on-error: true
  run: |
    set -o pipefail
    npx qa-skill workflow run --input workflow-input.json | tee qa-run.json
- if: always()
  run: |
    RUN_ID=$(jq -r .runId qa-run.json)
    npx qa-skill export --root . --run-id "$RUN_ID" --format junit --out qa-junit.xml
    npx qa-skill export --root . --run-id "$RUN_ID" --format sarif --out qa.sarif
- if: always()
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: qa.sarif
- if: always()
  uses: actions/upload-artifact@v4
  with:
    name: qa-run-artifacts
    path: |
      qa-run.json
      qa-junit.xml
      qa-junit.xml.provenance.json
      qa.sarif
      qa.sarif.provenance.json
- if: steps.qa.outcome == 'failure'
  run: exit 1
```

**The pitfall this exists to teach:** `workflow run` exits `1` on `NOT_READY`
(`src/cli/exit-codes.ts:39`), the exact outcome the gate exists to report. GitHub's own default for a
step with no `if:` of its own is `success()` — it runs only when nothing earlier failed — so a `qa` step
that fails on a `NOT_READY` gate would, by that default alone, skip every plain step after it: the export
calls, the SARIF upload, the artifact upload. The pipeline would lose its projections in precisely the
case they exist for, and lose them silently. `if: always()` on each of those steps overrides that
default and runs them regardless. `continue-on-error: true` on the `qa` step, together with reading
`steps.qa.outcome` (the result *before* `continue-on-error` is applied) rather than `steps.qa.conclusion`
(which `continue-on-error` masks to `success`) in the final step, is the other half: it keeps that step's
own failure from being what fails the job, so one deliberate final step — placed after the artifacts
already exist — is what fails it instead.

**A second pitfall, found only by running this end to end: `| tee` can swallow the first pitfall's exit
code.** `cmd | tee file; echo $?` reports `tee`'s exit status, not `cmd`'s — measured locally: without
`set -o pipefail`, the sequence above reports exit `0` for a `workflow run` that actually exited `1`.
GitHub's own default shell on Linux and macOS is `bash -e {0}` (no `pipefail`) unless a step or job sets
`shell: bash` explicitly, which adds `-eo pipefail`. Relying on that default being set somewhere else in
the workflow is fragile, so the `set -o pipefail` line above is not decorative: without it,
`steps.qa.outcome` reads `success` for a `NOT_READY` run, `continue-on-error` never has anything to
catch, and the final `if: steps.qa.outcome == 'failure'` step never fires — the exact silent-green
failure this whole section exists to prevent, reintroduced one layer up.

**A bracketed provenance in a row's name is a label, not an exclusion.** `qa-junit.xml` can contain a
testcase named `[agent-draft] TC-1 INST-1` — `renderJUnit` prefixes any attempt's name with
`[<provenance>] ` whenever that provenance does not credit coverage (`junit.ts:34-37`); the SARIF
renderer has no field of its own for provenance, so it names the row's own provenance in
`message.text` instead, unconditionally, whether or not that row credits coverage (`sarif.ts:36-40`).
Neither renderer drops the row. This is deliberate, not an omission a future pass should "fix": a
projection is a **report**, and a report "describes what the run recorded rather than what earned
credit" (`generate-qa-report.ts:39-41`) — filtering on `creditsCoverage` here would hide exactly what
the run recorded, the failure mode that decision already rules out for the JUnit/SARIF split itself. So
`[agent-draft] TC-1 INST-1` means the attempt happened and is reported, but earned no coverage credit
for whatever it targeted; it is not missing, and it is not a run that quietly downgraded a real result.

**A non-empty `unreadableRunnerReports` means one registered payload degraded, not that the export
failed.** Each entry names one registered `runner-report` evidence bundle that did not parse as a
sanitized runner report — `payload is not valid JSON`, or `payload is not a JSON object` — by artifact
id and relative path. The export still exits `0`; only the spec locations that specific report would
have contributed are missing from lane-2 rows it covers, not the results, the gate verdict, or the
run's recorded coverage credit. The same detail is also written to stderr, not only the JSON result, so
it surfaces in a CI log even when nobody parses stdout (`program.ts`).

**A non-zero `observedResultsWithoutLocation` means the SARIF placed none, or not all, of the failures
it reports.** It counts the `observed-failure` results emitted with no `locations` — a code-scanning
reader is shown the failure with no file to open. It is a SEPARATE signal from
`unreadableRunnerReports`, because the payload behind an unplaced result may have read perfectly and the
join still failed: a `config.rootDir` the `--root` checkout does not contain (exporting a run on a
different machine from the one that produced it, or across a symlinked `/tmp` prefix), two reports
disagreeing about where one identity ran, or a path no URI can spell. The reasons are deliberately not
distinguished in the output — all of them mean "this run cannot say where" (`sarif.ts`). The export
still exits `0`, the gate verdict is projected in full, and a non-zero count is also written to stderr.
The field is **absent for `junit`** rather than `0`: `renderJUnit` carries no location field at all, so
a `0` there would read as "every failure was placed" when the truth is that JUnit never places any.

**The sidecar, and what it does and does not prove.** `<out>.provenance.json` is written only after its
projection is written successfully, and binds a hash of the projection's own bytes (`projectionSha256`)
to the run it was projected from: the gate artifact's id, sha256, and recommendation, every other
artifact the gate was derived from (id, sha256, type), the `reduced` flag, the producer version, and the
generation timestamp. The checksum is of the file the sidecar sits beside, not of anything the run itself
produced.

**Neither file is signed, so the two alone prove consistency, not authenticity.** The sidecar is plain
JSON written by the same command into the same directory with the same permissions as the projection, so
anyone who can edit `qa-junit.xml` can recompute its sha256 and rewrite the sidecar to match. Holding
only the two files, you can detect a projection that was corrupted in transit, truncated by an artifact
store, or edited by someone who did not think to update the sidecar — and nothing more. What makes the
pair mean something is the third thing it points at: `runId`, `gate.artifactId`, `gate.sha256` and
`sourceArtifacts` name artifacts inside a run workspace whose manifest is checksummed and re-verified on
every read. Check the sidecar against that workspace — `qa-skill validate --root <path> --run-id <id>`
reopens and re-verifies it — and the claim becomes one an editor of the two files cannot forge. Treat a
projection and its sidecar arriving without the run behind them as consistent, not as vouched for.

**A protected-environment run produces a reduced projection.** When the run's release gate carries
`protectedEnvironment: true`, `export` carries that through as `reduced: true` on both the printed result
and the sidecar. Identifiers, statuses, severities, execution surfaces, counts, and any spec location a
lane-2 entry joined all survive reduction unchanged; only free-form authored or telemetry-derived text is
stripped — an evidence gap's `reason`, a shared-blocker's quoted `affectedClaim`. Check `reduced` before
treating an absent explanation as a missing one: it may be a redaction, not a gap in the run.

**A SARIF result with no `locations` is one the run has no honest file position for, not an omission.**
A result carries a location only when it is a lane-2 (Runtime-Observed Execution) failure whose spec file
was actually joined from that execution's sanitized runner report — the only case where a real path
inside a committed spec tree exists to name. Every other result — a failing gate rule, an open-bug or
unmet-coverage finding, a lane-1 browser-driven attempt — is emitted without one, because inventing a
location from a test case name or a change diff would assert more than the run knows. This has a real
consequence for a SARIF consumer: GitHub's code scanning documentation states that a result needs a
location for GitHub to display it at all, so a location-less result uploads successfully but does not
appear as an inline annotation — the JUnit output is the projection that shows every gate rule and every
attempt regardless of whether either carries a file position.

**A location's `uri` is relative to `--root`, and a spec that cannot be placed under it gets none.** A
Playwright report states each spec's path relative to its own `config.rootDir`, not to the repository —
under the ordinary `testDir: "./e2e"` that path is `checkout.spec.ts` for a file at
`e2e/checkout.spec.ts` — while SARIF and GitHub code scanning read `artifactLocation.uri` relative to
the repository root. `export` therefore resolves each spec against the `rootDir` its own report recorded
and re-expresses it relative to `--root`, so pass the checkout directory as `--root` (the pipeline above
passes `.`) or the URIs will not line up with the files GitHub is annotating. A spec that resolves
*outside* `--root`, or a report carrying no absolute `config.rootDir`, yields **no** location rather
than a guessed one — so does a run exported from a checkout at a different path than the one that
produced it, since the two cannot be shown to be the same directory without resolving paths that may no
longer exist. In each case the result still uploads and the gate verdict is unaffected; only the inline
annotation is missing.

## Skill use

The `qa-tester` Skill Adapter orchestrates the Full QA Lifecycle. Ask an agent to use it when requirements, test design, controlled data, browser execution, evidence, defects, and reporting should stay in one immutable QA Run.

Standalone adapters call the same typed QA Operations:

- `requirement-analyzer` — agent-authored requirement authority analysis
- `testcase-designer` — agent-authored bounded Test DSL and coverage design
- `test-data-manager` — runtime-backed trusted setup and idempotent cleanup
- `browser-test-executor` — runtime-backed Playwright execution
- `evidence-collector` — runtime-backed live-session capture and redaction
- `bug-reporter` — runtime-backed defect eligibility, reproduction, and triage
- `qa-report-generator` — runtime-backed release gate and report projections

Example agent request:

```text
Use the qa-tester skill in full mode against the local test environment.
Treat the acceptance criteria in docs/profile.md as authoritative.
Do not perform external or destructive side effects.
```

For a standalone operation:

```text
Use the evidence-collector skill for run <run-id> and attempt <attempt-id>.
Capture only the channels permitted by the registered evidence policy.
```

## Agent-specific installation

Project installations are recommended because runtime binding and review travel with the repository:

```bash
qa-skill skills install --agent codex --target project
qa-skill skills install --agent claude --target project
qa-skill skills install --agent cursor --target project
```

The roots are `.codex/skills`, `.claude/skills`, and `.cursor/skills`. Use `--target user` for the corresponding directory under the user home. The installation manifest binds the runtime command, real path, resolution source, version, and executable checksum; `skills verify` fails closed with a typed Runtime Binding status if any of that identity is missing, changed, or incompatible. After source updates, run `skills verify`, then `skills update`; never patch an installed copy directly.

## Two execution lanes

A test result satisfies a **Coverage Obligation** only when the QA Runtime observed the run that produced it.

- **Lane 1** — the runtime drives the browser over a bounded Test DSL and registers one `test-result` per attempt.
- **Lane 2** — `qa-skill execute playwright` starts your own committed Playwright suite, captures its exit status and JSON report, and registers one `test-result-batch` anchored to the commit and a checksum of the committed spec tree.

A result file handed to the runtime by any other route stays an **Agent Draft**: reportable, never coverage-crediting.

Lane 2 identifies a spec by a tag in its `test(...)` title — `[qa:<testCaseId>/<revisionId>/<instanceId>@<surface>]` — which lives inside the spec tree, so the batch's own `specTreeSha256` covers it and whoever merged the spec reviewed it. The surface may be `api`, `unit`, `integration`, `performance` or `security`. **`browser` is refused**, with a message pointing back at lane 1: a browser result must record the engine and viewport it ran at, and a Playwright JSON report exposes neither. A spec with no tag, or one naming a test case the run never registered, is excluded and listed rather than silently dropped.

The anchor is resolved **before** the runner starts, and a refusal from it means no process starts. A spec directory that is dirty relative to its commit — including untracked and **gitignored** files — is refused and exits `2`. Also refused, on `3`: a sparse checkout or an `--assume-unchanged` entry (both hide working-tree edits from the dirty check while their bytes would still enter the digest), a submodule or tracked symlink inside the spec directory, and a spec directory with no tracked files. In a real project a repository-root `--spec-dir` essentially always refuses, because `node_modules/` is ignored and therefore listed; point it at the directory holding your specs.

Two more refusals, both exiting `4`. **Every spec file the runner's report names must live inside `--spec-dir`** — a `--config` after `--`, or a `playwright.config` whose `testDir` is broader, would otherwise credit coverage from files the spec-tree checksum never hashed; one spec outside refuses the whole run and the offenders are named. And **the anchor is resolved a second time once the runner exits**, so a spec tree the run itself changed — a `globalTeardown` or an exit hook writing into it — refuses rather than being recorded under an anchor describing bytes that are no longer there. That second check also means your spec directory must hold spec sources only: the runtime forces its own artifact directory and JSON report outside the repository, but it cannot move a path your own config or `globalSetup` writes to, and such a path now fails the run that wrote it instead of only the next one.

**What lane 2 proves, and what it does not.** The runtime picks the runner binary, pins the reporter, starts the process, captures its exit status and re-checks the anchor afterwards — that is the `runtime-observed` claim. The per-spec results are then read out of the JSON report that same process wrote, and the runtime applies no integrity check to that file, because the code that writes it is loaded inside the process being observed. Your `playwright.config`, a `--config` after `--`, `globalSetup`/`globalTeardown`, fixtures and every helper they import run with the runtime's trust, and nothing requires any of them to live under `--spec-dir`; an ordinary project's config sits at the repository root, outside it and absent from `specTreeSha256`. The digest covers **every tracked file** under `--spec-dir`, not only `*.spec.*` — so a `specs/fixtures.ts` you do keep there is anchored and reviewed like any spec, while the config that loads it is not. A config that installs an exit hook over the report file can author what gets recorded. So a batch binds a committed, human-merged spec tree — proven to have still been standing when the runner exited — to an execution this runtime started and whose exit it saw. It does not certify that those bytes, and only those, produced each recorded status: none of the code that could author it has to be committed at all. Lane 2 is an anchoring and provenance mechanism, not a sandbox.

The registered evidence is a **sanitized projection** of the reporter's output, never the report file the runner wrote: that file carries `config.argv` and, for an ordinary web project, `config.webServer.env`. The payload states its own removals, and the trade is explicit — the artifact records which spec ran and how it ended, not why it failed. The command prints `runnerWorkingDir`, the temporary directory holding the runner's verbatim report and artifacts, so the failure text is still reachable while the run is being diagnosed.

`skills/shared/references/observed-execution.md` is the full adapter document.

## Filtered runs over both lanes

In `regression` mode, the cases a change scope selects are driven by whichever lane covers them: a
selected case a Runtime-Observed Execution already covered is not driven again by lane 1, and — the other
half of the same filter — a selected case covered by **neither** lane leaves the run's checkpoint unable
to validate (`src/core/inspect-workspace-state.ts`) rather than letting the run complete silently short of
it. `workflow scaffold` carries the
whole flow with two options added for it, `--observed-execution` and `--resume-run-id`, so nothing here
needs a hand-edited input file:

```bash
qa-skill workflow scaffold --root . --mode regression \
  --source-root . --source-run-id "$PLAN_RUN" \
  --change-scope-file scope.json --observed-execution \
  --output regression.json
qa-skill workflow run --input regression.json > paused.json   # exit 2, AWAITING_OBSERVED_EXECUTION
RID=$(jq -r .runId < paused.json)
qa-skill execute playwright --root . --run-id "$RID" --spec-dir specs -- --workers=1
qa-skill workflow scaffold --root . --mode regression \
  --source-root . --source-run-id "$PLAN_RUN" \
  --change-scope-file scope.json --observed-execution \
  --resume-run-id "$RID" --output resume.json
qa-skill workflow run --input resume.json                     # exit 0
```

Run end to end against a real project, this pauses a `regression` run in front of `execute-browser-test`,
credits one `test-result-batch` from a real `qa-skill execute playwright` run, and resumes to drive only
the residual — the selected case that batch did not cover. The selection names both cases; exactly one
`test-result` is registered (the driven one); and `qa-skill validate` reports `{ "valid": true,
"diagnostics": [] }`.

**`workflow run` exits `2` while it waits for the observed suite, and the run is not finished.** A CI step
that treats that exit code as a failure to report loses the run; one that treats it as success reports a
gate that was never written. Read `outcome` (`"AWAITING_OBSERVED_EXECUTION"`) and `pendingObservedExecution`
from the JSON body, not the exit code alone — see
[`AWAITING_OBSERVED_EXECUTION`](skills/shared/references/recovery.md#awaiting_observed_execution) in the
recovery reference.

**`--observed-execution` must be passed again when scaffolding the resume input**, even though the run
already knows it is waiting for one. The field sits inside the input's own checksum
(`workflowInputChecksum` in `src/operations/run-workflow.ts`), so a resume that silently drops it no
longer matches what the paused run's `workflow-checkpoint` recorded, and `workflow run` refuses it —
`"Resume input does not match its durable workflow checkpoint"`, exit `3` — rather than quietly resuming
without the pause it needs.

**A suite whose tagged specs were all skipped re-pauses instead of completing.** `execute playwright`
still succeeds and still registers a batch — a Playwright `skipped` result is a real, valid entry, not an
error — but a skipped test observed nothing, so it credits no case identity: `observedCaseIdentities`
(`src/core/observed-coverage.ts`) credits an entry only when its status is `PASSED` or `FAILED`. Resuming
a run whose only observed batch skipped every tagged spec reaches the identical
`AWAITING_OBSERVED_EXECUTION` pause again — not a hang — and it clears only once an observed execution
actually executes the tagged spec.

Lane 2 is never told what to run beyond `--spec-dir`. Only a spec whose `test(...)` title carries
`[qa:<testCaseId>/<revisionId>/<instanceId>@<surface>]` is observed at all; every other spec in the suite
is excluded and named in the command's own output (see [Two execution lanes](#two-execution-lanes) above).

`changeScope` is authored by `--change-scope-file`, and its `provenance.kind` — `"declared-change"` above,
or `"git-diff"`/`"user-change"` — is a caller-asserted label. Two things are true of it and neither is the
one people assume. It IS immutable once recorded: `registerChangeScope` folds the label into the change
scope's `inputChecksum`, and `changeScopeRule` (`src/core/semantic-rules.ts`) recomputes that checksum on
every read, so nobody can edit it afterwards. It is NOT verified: no code compares `"git-diff"` against an
actual diff, or `"declared-change"` against an approval. It also earns nothing — `selectRegressionCases`
(`src/regression/selector.ts`) reads only the five mapping arrays, never the label, so every selection
decision comes from the declared arrays whatever the label claims. Read it as a durable record of what the
caller said, not as evidence that anything was inspected.

**`retest` mode does not participate in this filter, and `workflow scaffold` refuses
`--observed-execution` for it.** What is true of `retest` is that it never consults the observed set at
all: its own handling of `execute-browser-test` (`src/operations/run-workflow.ts`) reads no batch, so no
observed entry can change what it drives. That is not the same as driving "unconditionally" — the same
mode filters out every selected case whose identity is one of the source bug's reproduction scenarios, and
when that empties the list it drives ZERO cases and rehydrates the reproduction attempts instead. A
`retest-result` binds each scenario to a specific `sourceAttemptArtifactId` and `attemptId`, and a lane-2
batch entry carries neither, so a retest's reproduction — and its regression tail — are lane-1 by
construction. The pause predicate itself is mode-agnostic (`pendingObservedExecution` in
`src/operations/observed-pause.ts` gates on the operation, not the mode, and clears only on a credited
identity as described above), which is exactly why the flag is refused at the edge instead: armed on a
`retest` run it really would fire, it cannot be dropped on resume because it is inside
`workflowInputChecksum`, and it clears only from an observed execution the run cannot use.

## Environment and side-effect safety

- `production` requires explicit read-only opt-in and permits only `none` side effects.
- `reversible` operations require owned Test Resources and an idempotent cleanup action.
- `external` operations require a scoped, expiring External Effect Permit.
- Destructive actions, real payments, wildcard recipients, arbitrary shell hooks, and undeclared environments are denied.
- Every browser attempt gets a fresh context. Emulated mobile is not a real-device or cross-browser claim.
- Test Data Hooks are pre-registered typed capabilities; agents do not improvise setup or cleanup commands.

## Evidence and redaction

Evidence listeners start before the actions they observe. Protected targets persist Sanitized Raw Evidence only; annotations are derived separately. Mandatory selectors or regions are masked before screenshot bytes are registered. After any secret is resolved, screenshots require provable secret-derived masking regardless of environment classification; otherwise the runtime registers an Evidence Gap without creating PNG bytes. Other unsafe captures likewise become Evidence Gaps.

### Trace retention is opt-in

A browser trace archive embeds un-provably-redacted DOM and network content, so trace retention is **off by default** and no trace is even started unless the environment permits it. To opt in, set `evidenceProtection.retainTrace: true` on the Environment Profile and raise the trace evidence mode above `off` (for example `on-failure`, `always`, or `required`). Even when retention is permitted, a trace is still refused — recorded as an Evidence Gap instead of an archive — if a secret was resolved during the attempt or the environment is protected. Declaring any `domSelectors` or `regions` redaction target makes the environment protected (no archive channel can prove that target was masked), so traces are never retained there. When `retainTrace` is absent or `false`, nothing is captured and no gap is recorded — the environment has simply opted out.

Known secrets are scrubbed from errors and telemetry. Never put resolved credentials, cookies, personal data, or production payloads in testcases, examples, bug reports, or logs. The checked-in `examples/` use fixed synthetic identifiers and `.test`-style data.

## Artifact layout

The manifest, not the directory layout, is authoritative:

```text
qa-results/<run-id>/
├── run-metadata.json
├── artifact-manifest.json
├── inputs/
└── evidence/

demo-artifacts/<run-id>/
├── screenshots/raw/
├── screenshots/annotated/
└── traces/
```

Every canonical descriptor and binary is registered in the manifest with a checksum; relationships use artifact IDs. `demo-artifacts/` contains convenience copies only and is never authoritative. Consumers must not scan for the newest run or guess filenames. A completed run is immutable; retest, regression, and cleanup create linked runs.

## Troubleshooting

- **Chromium executable missing:** run `npx playwright install chromium` during setup. QA execution itself will not download it.
- **Runtime missing/incompatible:** install the pinned package locally and run `qa-skill runtime verify`; do not use a remote fallback.
- **`AWAITING_RUNTIME`:** provide the configured browser/test-data service IDs and resume the same nonterminal run.
- **`AWAITING_HUMAN_INPUT`:** have the named person run the command `pendingHumanInput` identifies (`qa-skill approval record` or `qa-skill attestation record`) against the paused `runId`, then resume the same nonterminal run — see [recovery](skills/shared/references/recovery.md#awaiting_human_input).
- **Live lock:** confirm no active process owns the run; do not delete lock files blindly.
- **Artifact validation failure:** inspect normalized diagnostics, fix the canonical JSON or source draft, and generate a new artifact. Do not edit Markdown projections.
- **Evidence Gap:** repair the capture/redaction policy or selector and create a new attempt; never substitute an unregistered file.
- **Installer drift:** review `skills verify`; use `skills update --force` only after intentionally accepting local replacement.
- **Demo returns nonzero:** confirm Chromium is installed and that local loopback connections are permitted, then rerun `npm test -- tests/e2e/demo.test.ts`.

## Development and governance

Run the full local gate:

```bash
npm ci
npm run generate:types
npm run check:generated
npm run typecheck
npm run lint
npm test
npm run demo
npm run build
npm run smoke:package
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Licensed under Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
