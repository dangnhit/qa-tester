# Recovery reference

Read this whenever a `qa-skill` command exits non-zero, or whenever `qa-skill workflow run` returns —
its JSON result carries more than the exit code does. Do not report success or failure to the user
until you have reconciled both.

## Exit codes

`qa-skill` uses six process exit codes (`src/cli/exit-codes.ts`):

- `0` `SUCCESS`
- `1` `UNMET_OBLIGATIONS`
- `2` `BLOCKED`
- `3` `INVALID_INPUT`
- `4` `SAFETY_DENIED`
- `5` `ABORTED_OR_INTERNAL`

For `qa-skill workflow run`, the exit code is derived from the returned `WorkflowResult` — first match
wins:

1. `outcome === "ABORTED"` → `5` (`ABORTED_OR_INTERNAL`)
2. `outcome === "BLOCKED"` → `2` (`BLOCKED`)
3. `outcome === "AWAITING_RUNTIME"` (nothing executed) → `2` (`BLOCKED`)
4. `validation.valid === false` → `1` (`UNMET_OBLIGATIONS`)
5. `releaseRecommendation === "NOT_READY"` → `1` (`UNMET_OBLIGATIONS`)
6. `outcome === "COMPLETED_WITH_FAILURES"` → `1` (`UNMET_OBLIGATIONS`)
7. otherwise → `0` (`SUCCESS`)

`READY_WITH_RISKS` and "no gate registered" (`plan`, `execute`, `exploratory`, and `retest` modes) both
fall through to `0` — a risk-flagged go verdict is still success at the process boundary; read
`releaseRecommendation` to see the risk.

For every other `qa-skill` command, a thrown error maps by its internal code: `LIVE_LOCK` → `2`
(`BLOCKED`); `PATH_ESCAPE`, `SYMLINK_ESCAPE`, or `INSTALLER_SAFETY` → `4` (`SAFETY_DENIED`); anything
else → `3` (`INVALID_INPUT`).

## `AWAITING_RUNTIME`

`outcome: "AWAITING_RUNTIME"` means the workflow ran **zero** operations because a required runtime
binding was missing from the caller's registry — a browser manager for `full`, `execute`, `regression`,
`retest`, or `exploratory` modes; a test-data registry for `full` mode.

This is a **caller configuration gap**, not a workspace problem: nothing about the registered artifacts
or the workspace itself is wrong. The run's process lock is still released (workspace close always
releases it, on every exit path), the run stays in its non-terminal status, and the run is **resumable**
— pass its `runId` back in as `resumeRunId` once a compatible runtime registry is supplied, and the
workflow continues from where it stopped. Exit code `2` (`BLOCKED`).

Do not treat `AWAITING_RUNTIME` as a failed run to discard. Fix the caller's runtime registry and resume
the same run.

## Live lock (`LIVE_LOCK`)

A run workspace holds a `.run.lock` file for as long as it is open. If another process opens the same
run while that lock file still names a **live** process (checked with `process.kill(pid, 0)`), the
newer open fails with `LIVE_LOCK` — exit code `2` (`BLOCKED`).

If the lock's recorded pid is dead, the runtime does not need help: it auto-recovers the lock through a
claim-based election among any processes that saw the same stale lock, without your intervention. A
`LIVE_LOCK` error therefore means a **genuinely live** process already holds the run open. Wait for it
to finish (it will release the lock on close) or stop it — do not delete `.run.lock` by hand and do not
force a second open.

## Evidence Gap

An `evidence-gap` artifact is an explicit, honest record that some required evidence could not be
captured or persisted **safely** — for example, a screenshot is refused because a secret has been
resolved into the page and cannot be deterministically masked, or because the environment is marked
protected and no verifiable redaction policy covers it. Every gap carries a `reason` and the
`affectedClaim` it leaves unsupported.

A gap is the honest substitute for an unsafe artifact, not a bug in the runtime. Its presence in a run
is expected whenever safe capture genuinely was not possible, and is not by itself a failure — but it
does mean the claim it names is unproven, and reporting skills must treat it as such (an unsupported
claim, not a verified pass).

## Artifacts from a run written by an older version

Every artifact declares a `schemaVersion`, and the runtime validates against exactly one version per
artifact type. When a schema takes a breaking change its `schemaVersion` is bumped (for example
`evidence` went `1.0.0` → `2.0.0`), and artifacts written by an older version of the package stop
validating. Reopening such a run reports validation diagnostics rather than silently accepting a shape
the current contract no longer describes.

A run is self-contained, so the remedy is to **start a new run** — there is nothing to repair in place.
No migration path is offered before v1.0: there is no converter, no compatibility mode, and no
multi-version validator. Artifacts from a prior run are read-only history; do not hand-edit their
`schemaVersion` to make them validate, because the rest of the payload will not match the new contract
and the checksum will no longer match the manifest.

That is the whole story only when the artifact you are re-reading belongs to the run you opened. It is
not the whole story for `retest` and `regression`, both of which open a second, **linked source run** and
read its artifacts too: `retest` mode's `sourceBugFromReference` and `regression` mode's
`importRegressionCases` (`src/operations/run-workflow.ts`) each call `readRegisteredArtifacts()` on the
linked/source run, not just the run being opened. Cross-run duplicate-bug detection does the same thing
a third and fourth way — the read-path check in `src/core/semantic-rules.ts` and the write-path check in
`src/operations/generate-bug-report.ts` both open every run named in a bug report's
`possibleDuplicateSources` and read its registered artifacts to verify the reference.
`readRegisteredArtifacts()` (`src/core/run-workspace.ts`) throws on **any** diagnostic in the run it
reads — not only on the specific artifact a caller wanted — so if that other run contains even one
`evidence` artifact written before the `2.0.0` bump, all four of these flows fail, and they fail while
acting on the *other* run, not the one you asked to open. Since any run that has actually executed and
captured evidence writes `evidence` artifacts, this means a source run from before the bump is
permanently unusable as a retest target, a regression baseline, or a duplicate-comparison source. The
error you will see on the CLI is exactly `Workspace artifact binding is invalid: Payload does not match
declared artifact type evidence` — `src/cli/program.ts`'s top-level handler prints only `error.message` to
stderr, with no code prefix. The thrown `QaSkillsError`'s separate `code` property is `ARTIFACT_BINDING`
(readable by a caller that catches the error object directly rather than reading CLI stderr), but that
code is never concatenated into the printed text. Recognize the message as "the *linked* run's evidence
no longer validates," not as a problem with the run you just opened. "Start a new run" does not recover
this: the new run reads fine, but the bug it would retest, or the baseline it would import, stays locked
behind the old-schema source. The only remedy is to **re-execute the linked source run under the current
package version** so
it writes fresh `evidence` at `2.0.0`, then retest, regress, or compare against that new run instead.

**A bootstrap bundle is not exempt — it is now the most likely thing to break.** A source run created by
`qa-skill workflow bootstrap` (a `plan`-mode run) never registers `evidence`, so the `evidence` story
above does not reach it. But it holds `requirement-analysis`, `test-plan`, `test-case`, and
`coverage-obligation`, and **two of those four broke in this release**: `test-case` went `1.0.0` →
`2.0.0` and `coverage-obligation` went `1.0.0` → `3.0.0`. The same mechanism applies with the same
force. `buildCanonicalPlanImportBatch` (`src/operations/run-workflow.ts`) opens the source run and calls
`readRegisteredArtifacts()` on it, which throws on the **first** diagnostic in that run — so a bootstrap
bundle written before this release fails the import outright, and it fails while acting on the *source*
run, not the `full`-mode run you just started.

An earlier revision of this section said the opposite — that linking to a bootstrap bundle is "safe no
matter how old that bundle is". That is now false, and it was the sentence most likely to be read after
a break. The `--source-root`/`--source-run-id` pattern in
[agent-browser-adapters](./agent-browser-adapters.md) is still the right pattern; what changed is that
the bundle it points at must have been produced by the **current** package version.

The remedy is the same shape as above and no worse: re-run `qa-skill workflow bootstrap` against the
current version to write a fresh plan bundle, then link the new `full`-mode run to *that* bundle. Unlike
the executed-source-run case, this is cheap — bootstrapping registers no evidence and drives no browser;
it re-validates the same four agent-authored files. Any `test-case` or `coverage-obligation` file you
kept on disk will need its `schemaVersion` raised to the current contract first (and
`coverage-obligation` additionally needs `executionSurface`, and an `accessibilityMethod` drawn from the
enum rather than a free-form label) — `qa-skill draft init --type <t>` prints a current-shape skeleton,
and `qa-skill schema show --type <t>` prints the contract itself. Do not raise a `schemaVersion` inside
an already-registered artifact: those are read-only history, and the checksum in the manifest will no
longer match.

## Attestation and the gate: there is no position between them

**There is no `qa-skill report generate` command.** Earlier revisions of this reference and of
[artifact-authoring](./artifact-authoring.md) named one; it never existed. The commands this CLI
actually has are `init`, `run create`, `skills list|install|verify|update|uninstall`,
`workflow run|scaffold|bootstrap`, `runtime verify`, `schema show`, `draft init`, `fingerprint`,
`artifact ingest`, `approval record`, `attestation record`, and `validate` (`src/cli/program.ts`). The
`release-gate` and `qa-execution-report` artifacts are written by the `generate-qa-report` **operation**,
which runs only inside `qa-skill workflow run`, and only in `full` and `regression` modes
(`src/core/modes.ts`).

So the honest statement is stronger than an ordering rule: **`qa-skill attestation record` has no
reachable position in a shipped workflow today.**

- `qa-skill workflow run` registers the coverage obligations, runs every operation for the mode,
  generates the gate, and finalizes the run in a **single process invocation**
  (`runQaTesterWithAdapters`, `src/operations/run-workflow.ts`) — there is no pause to step into.
  Before it, the obligation is not in the run, and `attestation record` refuses ("Human attestation
  requires exactly one registered coverage obligation carrying that obligation ID"). After it, the run
  is terminal and refuses every write with `TERMINAL_WORKSPACE` ("Terminal workspace is immutable",
  `src/core/run-workspace.ts`).
- The one non-terminal early return, `AWAITING_RUNTIME` (see above), returns **before** the operation
  loop runs `ingest-coverage-obligation`, so at that point there is still no obligation to attest to.
  (It is also not reachable from the CLI at all: `qa-skill workflow run` always supplies the local
  browser manager, and for `full` mode the local test-data registry, so `missingRuntimeLabel` never
  fires — `AWAITING_RUNTIME` is a programmatic-`createQaTester` outcome.)
- Staging an attestation in a bootstrap run does not carry it forward. `qa-skill workflow bootstrap`
  finalizes its `plan` run too, and `human-attestation` is not one of the four canonical planning types,
  so a bundle import will not bring it across and `workflow scaffold` rejects a source run that holds
  one.
- `qa-skill run create` gives a non-terminal run that accepts an ingested `coverage-obligation` and then
  an attestation against it — but no command generates a gate for such a run, so nothing ever reads it.

**What this costs:** a coverage obligation with `required: true` and a manual `accessibilityMethod` is
not satisfiable by any shipped command sequence. It stays in `requiredMissing`, `REQUIRED_COVERAGE_COMPLETE`
fails, and the run gates `NOT_READY` — permanently, for that run and every later one authored the same
way. There is no recovery procedure for it, because there is nothing broken to recover: the runtime is
refusing to credit an obligation nobody witnessed. Authoring the obligation with `required: false`
instead reports it as an optional gap (`READY_WITH_RISKS`), which records "not covered" honestly rather
than manufacturing a pass.

The **human checkpoint** that would give the command a position — a workflow pause after the obligations
are registered and before the gate is generated — is Phase 7 work
(`docs/superpowers/plans/2026-07-24-production-readiness.md`), and is deliberately not in this release.

**The ordering rule still stands for whatever lands next.** A release gate is an immutable snapshot: it
is re-derived from, and checked against, every non-gate/non-report artifact registered in the run at read
time (`releaseGateRule` in `src/core/semantic-rules.ts`). Registering a `human-attestation` after the
gate exists changes what that re-derivation produces — `sourceArtifacts` gains the attestation, and
`ruleInputs` changes if it clears an otherwise-unmet Accessibility Obligation — so the persisted gate no
longer equals its own re-derivation, and the next read invalidates it with `ARTIFACT_BINDING`. There is
no regenerate-in-place fix: `generateQaReport` (`src/operations/generate-qa-report.ts`) refuses to run a
second time once a `release-gate` or `qa-execution-report` is registered, by design. Like the
"artifacts from a run written by an older version" case above, nothing is repairable in place, because
the artifact that would need to change is immutable by contract.

## Check the JSON body, not just the exit code

`WorkflowResult` (returned by `qaTester()` / `createQaTester()`, and printed as JSON by
`qa-skill workflow run`) carries three fields that matter more than the exit code:

- `outcome`: `"AWAITING_RUNTIME" | "COMPLETED" | "COMPLETED_WITH_FAILURES" | "BLOCKED" | "ABORTED"`
- `validation`: `{ valid: boolean, diagnostics: [...] }`
- `releaseRecommendation` (registered when the `generate-qa-report` operation runs — `full` and
  `regression` modes; not `plan`, `execute`, `exploratory`, or `retest`): `"READY" | "READY_WITH_RISKS" |
  "NOT_READY"`

The process exit code **collapses distinct situations together**. Exit code `1` alone does not tell you
whether the gate said "not ready" (`releaseRecommendation === "NOT_READY"`, with `validation.valid ===
true` — every structural obligation was met, and the *content* of the run does not clear the release
bar) or whether validation itself failed (`validation.valid === false` — a structural obligation is
unmet, and no release verdict was even reached). Exit code `2` alone does not tell you whether the
workflow is genuinely `BLOCKED`, or is `AWAITING_RUNTIME` and simply needs a runtime registry and a
resume.

Before reporting success or failure to the user, read `outcome`, `validation.valid` (and its
`diagnostics` when invalid), and `releaseRecommendation` from the JSON body. Do not infer the situation
from the exit code alone.
