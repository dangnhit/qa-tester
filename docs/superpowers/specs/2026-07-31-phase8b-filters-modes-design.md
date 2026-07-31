# Phase 8b — retest/regression as filters over both lanes, and all six modes CLI-reachable

Design for the second half of Phase 8 in `docs/superpowers/plans/2026-07-24-production-readiness.md:108`.
Phase 8a (JUnit + SARIF export) shipped and merged; this branch does not touch the projections.

Baseline: `main` @ `4f3111b`, CI green on all five jobs (run 30562590097). Gate at that head, controller-verified
from a deleted `dist/`: 1216/1216 tests (86 files), coverage 94.04/83.92/98.16/94.04 against the 90/80/95/90
floor, `scan:secrets` over 323 tracked files, `smoke:package` green.

## What exists already, and what does not

Verified this session with citations, so no implementer re-derives it.

**Lane 2 has no selection surface, and is not in the operation graph.**

- `qa-skill execute playwright` takes exactly `--root`, `--run-id`, `--spec-dir`, plus operands after `--`
  passed to the runner verbatim (`src/cli/program.ts:248-259`). There is no `--grep`, `--project`, `--shard`,
  `testIdMatch` or last-failed option anywhere in `src/observed/`. `--reporter` and `--output` are runtime-owned
  and refused in both whole-token and `=` form (`src/observed/run-playwright.ts:49,316-327`,
  `OBSERVED_RUN_ARGUMENT_REFUSED`).
- `operationNames` is a closed set that contains no observed operation (`src/core/modes.ts:6-8`), and
  `executeObservedPlaywright` has exactly one call site — the CLI (`program.ts:255`). Lane 2 attaches to an
  existing run: `const workspace = await RunWorkspace.open(input.root, input.runId)`
  (`src/operations/execute-observed-playwright.ts:348`). Each invocation mints a fresh `executionId` (`:377`),
  so one run may hold several batches (`src/reporting/projections/projection-model.ts:144`).
- An entry is bound to a canonical test case by the in-title identity tag
  `[qa:<testCaseId>/<revisionId>/<instanceId>@<surface>]`, parsed from the leaf `test(...)` title only
  (`src/observed/report-mapping.ts:41,196-198`). Matching is on that triple
  (`execute-observed-playwright.ts:73-81`, key `` `${testCaseId}/${revisionId}/${instanceId}` ``). An untagged
  test is **excluded, not refused** (`report-mapping.ts:221-223`); an ambiguous or `@browser` tag refuses
  (`:229-235`, `:145-154`); zero entries is `OBSERVED_RUN_NO_ENTRIES`
  (`execute-observed-playwright.ts:368-375`).
- A batch entry carries `entryId, testCaseId, testCaseRevisionId, testCaseInstanceId, status,
  failureClassification, executionSurface, steps` plus optional `observedEngine`/`viewport`/`evidenceArtifactIds`
  (`shared/schemas/test-result-batch.schema.json`, `additionalProperties: false`). **No entry carries a spec
  path** — that lives only in the sanitized evidence (`src/observed/sanitize-report.ts:64,68`), which is how
  Phase 8a's SARIF join reads it (`src/reporting/projections/spec-locations.ts:192-209`).

**`retest` and `regression` are lane-1 only, and unreachable from the CLI.**

- Step lists are fixed (`src/core/modes.ts:33-34`): both go through `execute-browser-test`, and the browser-manager
  guard covers `full, execute, regression, retest, exploratory` (`src/operations/run-workflow.ts:332`), returning
  `AWAITING_RUNTIME` when it is absent.
- Both modes require a change-scope source: `resolveRuntime(runtime.changeScopeSources,
  input.runtime?.changeScopeSourceId, "change-scope source")` (`run-workflow.ts:972` for retest, `:1055` for
  regression), which throws `Workflow runtime change-scope source is not configured` (`ARTIFACT_BINDING`,
  `:464-467`). **No CLI path populates `changeScopeSources`** — `runLocalWorkflow` registers only
  `browserManagers`, `testDataRegistries`, `evidencePolicies` (`src/cli/workflow.ts:117-121`); the only
  populators in the repo are tests. So `retest` and `regression` are unreachable through `workflow run` even
  with a hand-edited input file.
- `scaffold` emits exactly `root`, `mode`, `environmentProfile`, and optionally `bundle`
  (`src/cli/workflow.ts:94`), and never validates `mode` against `publicWorkflowModes` — `ScaffoldOptions.mode`
  is `string` (`:17`), so a typo is written out silently. Missing for the three unreachable modes: `charter`
  (exploratory, refused at `run-workflow.ts:1027`), `retest.sourceBug` + `linkedRunId` (retest, refused at
  `:971`), `runtime.changeScopeSourceId` (both). Each surfaces as exit 3 (`program.ts:299,325`).
- The bundle source path **refuses a run holding non-planning artifacts** (`workflow.ts:85`), so the plan-bundle
  source run and a retest's bug source run are necessarily two different runs.
- `QaWorkflowInput.retest` is `{ sourceBug: RegisteredArtifactRef }` (`run-workflow.ts:124`); the wider
  `WorkflowInput.retest` at `:79` is the unsafe test seam only (`:782-786`). `sourceBug` must name a
  `bug-report` in the linked run whose checksum matches, each of whose source attempts resolves to a
  `PRODUCT_DEFECT` `test-result` bound to the exact case triple (`sourceBugFromReference`, `:637-664`).
  `linkedRunId` is the only route to that run (`:958,963,638-639`), and is stamped into the `retest-result` as
  `sourceRunId` (`:680`). The unsafe seam pre-checks it (`:1124`); **the production path does not**, so a
  scaffolded retest without it fails late inside `reproduce-bug`.
- CLI end-to-end coverage today: `plan` (`tests/cli/workflow.test.ts:110-112`) and `full`
  (`tests/operations/awaiting-human-input.test.ts:243,273`). `execute`, `exploratory`, `retest`, `regression`
  are exercised **library-only**, through `createQaTester` in `tests/orchestration/runtime-public.e2e.test.ts`.
  This is wart MODE-1 measured rather than asserted.

**What the selection already is.** `selectRegressionCases` matches each change's `requirementIds`,
`codeSurfaces`, `declaredDependencies`, `gitPaths`, `userScope` against the same five fields read off each
canonical test case's `regressionIndex` (`src/regression/selector.ts:9-14`,
`src/regression/change-scope.ts:10-19`), keeps the strongest source per instance, and reports
`unmappedChangeRisks` — which `release-gate.ts:277` already reads. `registerChangeScope` refuses an empty
change list (`change-scope.ts:38`).

**The pause machinery already exists.** `AWAITING_RUNTIME` and `AWAITING_HUMAN_INPUT` are the two non-terminal
outcomes (`run-workflow.ts:83,88`); the human pause sits inside the operation loop, after the
already-completed branch and before `adapter.execute`, and its position is documented as load-bearing in both
directions (`:983-997`). Exit mapping is one ordered function, both non-terminal outcomes → `BLOCKED` (2)
(`src/cli/exit-codes.ts:16-41`).

## Decisions

Each was taken by the user during brainstorming; reasoning recorded so it is not relitigated.

1. **Lane 2 is verified, never selected.** The runtime does not compute a `--grep` and does not inspect the
   caller's runner arguments for one. The run's selection decides which observed entries credit the filter.
   Rejected: fabricating a `--grep` from the selection — its effect would have to be verified from the report
   anyway, so the argument buys narrower runs at the cost of a second mechanism claiming the same thing.
   Consequence accepted: a filtered lane-2 run executes the caller's whole suite.
2. **The run pauses for lane 2 and resumes**, mirroring `AWAITING_HUMAN_INPUT` rather than making step lists
   conditional per input. Rejected: a per-input step list, because `completed[]` would then mean different
   things for the same mode and `inspect-workspace-state` asserts against those lists.
3. **Lane 1 drives the residual.** The selection is one filter; whichever lane covered a case, it is covered
   once. Rejected: skipping lane 1 entirely (an operator could not mix a tagged suite with a driven case in one
   filtered run) and driving the whole selection anyway (the same case executed twice by two lanes, with no rule
   for which result wins).
4. **The pause is triggered by an explicit input field that joins the input checksum.** Rejected: a CLI flag
   (it would sit outside `workflowInputChecksum`, so the first run and the resume could disagree about the run's
   shape with nothing detecting it) and deriving the trigger from the selected cases' coverage obligations
   (`test-case` declares no `executionSurface` — only `coverage-obligation` does — so the derivation would hop
   case → requirement → obligation and one broad obligation would pause runs that never wanted lane 2).
5. **The change scope is authored inline in the workflow input.** Nothing is derived from git on this branch.
   Rejected: `--change-base` git derivation (real CI value, but renames, submodules, a dirty tree and the empty
   diff each need a decided answer — a branch of its own) and a run-time `--change-scope-file` (the input would
   stop being self-contained, and its checksum would cover a path rather than content).
6. **Scaffold derives the retest reference from a second explicitly named run.** Never typed by hand, never
   discovered. Rejected: emitting an empty placeholder (scaffold would knowingly write an invalid input, and a
   hand-typed `sha256` fails deep inside `reproduce-bug` instead of at the edge) and relaxing `workflow.ts:85`
   to let one run serve as both sources (that refusal is what keeps a plan bundle canonical).

## Architecture

### Half 1 — the filter spans both lanes

**Input.** `QaWorkflowInput` gains `observedExecution?: Readonly<{ expected: true }>`, and the field joins
`workflowInputChecksum` (`run-workflow.ts:139`). Absent field = today's behaviour, byte for byte.

**Outcome.** A third non-terminal outcome, `AWAITING_OBSERVED_EXECUTION`, added to `WorkflowResult.outcome`
(`:88`) and to `workflowExitCode` → `ExitCode.BLOCKED` (2), placed beside the other two non-terminal outcomes
so the documented first-match ordering in `exit-codes.ts:16-32` stays true. Like them it resolves ahead of
`validation.valid`: a paused run legitimately has not registered the artifacts its profile requires.

**Pause site and condition.** A `pendingObservedExecution(workspace, name, input)` check sits immediately
beside `pendingHumanInput` in the operation loop, before `execute-browser-test`. It pauses when
`input.observedExecution?.expected === true` **and** the run holds no `test-result-batch`. It therefore
inherits all four properties the human pause's comment states: it registers nothing, advances no checkpoint,
never calls `finalizeWorkflowOutcome`, and leaves the workspace writable for `execute playwright`. It is
self-clearing and idempotent — a resume with still no batch pauses again identically, so a resume can never
silently fall back to driving the whole selection.

**Residual.** When the run holds at least one batch, the case list handed to `execute-browser-test` is the
selected cases minus every case whose `testCaseId/revisionId/instanceId` triple appears in a batch entry.
The triple is what a batch entry already carries and what lane 2 already binds on; nothing new is parsed, and
no spec path is involved.

**An empty residual is refused twice today, measured, not assumed.** A lane-2 batch covering the whole
selection leaves nothing to drive, and `regression` refuses that in two places:

```ts
// run-workflow.ts:1082 — the non-retest branch of execute-browser-test
if (state.executionCaseIds.length === 0) throw new QaSkillsError("Runtime execution requires imported approved canonical test cases", "ARTIFACT_BINDING");
// run-workflow.ts:214 — assertResultPostcondition
if (output.length === 0 || output.some((item) => item.type !== "test-result")) throw new QaSkillsError("Execution operation must return registered test-result references", "ARTIFACT_BINDING");
```

`retest` is unaffected: its own branch already handles zero cases by reusing the reproduction attempts
(`:1075-1077`). Both refusals become the same union-coverage question the checkpoint invariant asks — zero
driven attempts is legal **only** when every case in the selection is covered by a `test-result-batch` entry
carrying its triple. Neither refusal is deleted: each still fires for the case its message actually describes,
a run with nothing to execute and nothing observed either. Returning the batch as the operation's output was
rejected — the postcondition's type check is what keeps `execute-browser-test`'s output a set of driven
attempts, and a lane-2 batch is not one.

**The checkpoint invariant this changes, and it is the load-bearing edit.**
`src/core/inspect-workspace-state.ts:476` today demands, for every non-`retest` mode, that checkpoint
`state.executionCases` **equal** the case refs of the driven results:

```ts
(!completed.includes("execute-browser-test") || value.mode === "retest" || sameCheckpointRefs(array(state.executionCases), executionCaseRefs))
```

Residual driving breaks that equality in `regression` mode. It becomes **union coverage**: every case in
`state.executionCases` must be covered by a driven `test-result` **or** by a `test-result-batch` entry carrying
the matching triple. The check stays total — a selected case covered by neither lane invalidates the
checkpoint, which is the property the equality was buying. `:473` (`state.executionCases` equals the
selection's selected refs, ordered) is untouched.

**No checkpoint schema change.** Storing lane attribution as a new `state.observedCases` field was rejected:
every schema pins `schemaVersion` with `const` (`workflow-checkpoint.schema.json` is `1.0.0`, `state` is
`additionalProperties: false`), so the field would bump the const and invalidate every pre-existing run's
checkpoint on `validate`. Attribution is derived instead — a triple in a batch entry is lane 2, a `test-result`
is lane 1 — the same derive-on-read habit `semantic-rules.ts:666-690` already uses for the gate, and the habit
Phase 8a's review confirmed by finding the gate re-derived on read rather than stored twice.

**Reporting — corrected against the schema after the design was drafted.** An earlier draft of this section
had the QA report carry the lane split as a new field. It cannot: `qa-execution-report.schema.json` is
`additionalProperties: false` with `schemaVersion` pinned by `const`, so the field would bump the const and
invalidate every existing run's report on `validate` — the same cost that ruled out the checkpoint field two
paragraphs up, and it applies identically here.

So **no artifact records the split, and none needs to.** It is derivable from the run's own artifacts by any
reader: a triple in a `test-result-batch` entry was observed, a `test-result` was driven, and Phase 8a's
projections already read both lanes (`projection-model.ts`). Squeezing the split into an existing field such
as `excludedNotRun` was rejected — those cases were excluded by the selection, not covered by another lane, and
overloading the field would make the report say something false. No gate rule change either: with lane 1
driving the residual, every selected case is covered by one lane or the other unless driving itself fails,
which is already an error path, and the amended checkpoint invariant is what makes that structural rather than
a matter of trust.

### Half 2 — MODE-1

**`runLocalWorkflow`** registers a change-scope source when the input carries `changeScope`:
`changeScopeSources: { "local-change-scope": input.changeScope }`, with `runtime.changeScopeSourceId` set to
that id. This single wiring is what makes `retest` and `regression` reachable at all.

**`scaffold` gains four inputs**, each refusing at the edge rather than deep in an operation:

| Input | Emits | Refuses |
|---|---|---|
| `--charter-file <path>` | `charter` | anything `assertExplorationCharter` rejects, at scaffold time |
| `--change-scope-file <path>` | `changeScope`, **inlined** so the run still reads one closed file | a scope whose `changes` is empty, matching `registerChangeScope` |
| `--bug-run-id <id>` | `linkedRunId` + `retest.sourceBug { artifactId, sha256 }` read from that run's manifest | a non-terminal run; zero `bug-report`s |
| `--bug-artifact-id <id>` | picks one when the run holds several | absent with 2+ candidates |

`ScaffoldOptions.mode` is validated against `publicWorkflowModes`, and the production `retest` path gains the
`linkedRunId` pre-check the unsafe seam already has at `:1124`.

## Error handling

Every refusal reuses an existing code; no new exit code is added, matching Phase 8a.

- Scaffold refusals (unknown mode, invalid charter, empty change scope, non-terminal bug run, ambiguous or
  missing `bug-report`) → `INVALID_ARTIFACT` → exit 3, the code every current scaffold refusal already uses.
- Missing production `linkedRunId` for retest → `ARTIFACT_BINDING`, the code the unsafe seam already throws.
- Pause → `AWAITING_OBSERVED_EXECUTION` → exit 2, no gate written, run not finalized.
- A selected case covered by neither lane → the checkpoint is invalidated with the existing
  `INVALID_REFERENCE` diagnostic, so `validate` reports it rather than a new mechanism.

## Testing

TDD, test first and watched failing, every test proven by mutation, no snapshots, ESM `.js` imports, no new
runtime dependency. The nine-command gate from a deleted `dist/`, floor 90/80/95/90.

**The filter tests assert consequence, not rejection** — the discipline Phase 8a's symlink round established:

1. Pause: outcome and exit 2, **and** the run holds no gate, is not finalized, and its checkpoint did not
   advance.
2. Resume after a batch lands: only the residual cases were driven, asserted on the registered `test-result`
   set, not on a log line.
3. Resume with no batch: pauses again identically.
4. An observed entry whose triple is outside the selection does not credit the filter.
5. `validate` stays valid on a residual-driven run, and **invalidates** when a selected case is covered by
   neither lane — both directions of the amended `:476`.
6. Absent `observedExecution`: a `regression` run behaves exactly as today, pinned by a test that fails if the
   pause fires unconditionally.
7. Both directions of the zero-residual amendment: a batch covering the **whole** selection completes with zero
   driven attempts, and a run with no cases and no batch still fails with the existing
   `Runtime execution requires imported approved canonical test cases` message — so the amendment cannot be
   mistaken for deleting the guard.

**MODE-1 is proven by a CLI end-to-end test per mode** — all six through `qa-skill workflow run`, replacing
the current two. That is the wart's closure condition: reachability asserted at the CLI, not in the library.

## Verification items carried into implementation

1. **The two zero-residual refusals are already measured** (`:1082`, `:214`) and their amendment is designed
   above, not open. What remains open is narrower: whether any OTHER caller reaches
   `assertResultPostcondition` with a legitimately empty output — it is shared with `reproduce-bug` (`:257`) —
   so the amendment must be conditioned on the observed-run case rather than applied to the postcondition
   unconditionally. Measure both call sites before editing.
2. **Which artifact the residual reads** — batch entries are read through `readRegisteredArtifacts`; confirm a
   batch that fails its semantic rule cannot contribute a triple to the residual computation, so an invalid
   batch cannot suppress driving.
3. **`checkpointStateChecksum`** — confirm the union-coverage change needs no state field, i.e. that
   `inspect-workspace-state` already has every artifact it needs in scope at `:476`.
4. **`hydrateCheckpointState`'s fallback** (`:953`) sets `executionCaseIds` from imported test cases when
   empty; confirm a resume after the pause does not widen the selection through that path.

## Out of scope

- Git-derived change scope (`--change-base`), and any inference of `provenance.kind: "git-diff"`.
- Any lane-2 selection mechanism: `--grep`, `--project`, `--shard`, last-failed.
- Changes to the JUnit/SARIF projections, a third format, or surfacing the filter in them.
- Reading the change scope from a file at run time; the file is a scaffold input only.
- A new artifact type or `artifactType` for lane attribution.
- The Phase 8a carry-forward items, none of which this branch touches: surfacing "every location dropped" in
  the export result, `RunWorkspace.open`'s unguarded `realpath` making an unknown run id exit 5 across four
  commands, missing schema patterns on `obligationId`/`evidenceGapId`, `export` exiting 2 via `LIVE_LOCK`, the
  24 hardcoded `producerVersion` literals, and `VALID_ARTIFACTS`'s dead second parameter.
