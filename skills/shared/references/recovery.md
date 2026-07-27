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
error you will see is `ARTIFACT_BINDING: Workspace artifact binding is invalid: Payload does not match
declared artifact type evidence` — recognize it as "the *linked* run's evidence no longer validates," not
as a problem with the run you just opened. "Start a new run" does not recover this: the new run reads
fine, but the bug it would retest, or the baseline it would import, stays locked behind the old-schema
source. The only remedy is to **re-execute the linked source run under the current package version** so
it writes fresh `evidence` at `2.0.0`, then retest, regress, or compare against that new run instead.

The common case is unaffected: a source run created by `qa-skill workflow bootstrap` (a `plan`-mode run)
never registers `evidence` at all — it holds only `requirement-analysis`, `test-plan`, `test-case`, and
`coverage-obligation` — so linking a new `full`-mode run to a bootstrap bundle (the
`--source-root`/`--source-run-id` pattern in
[agent-browser-adapters](./agent-browser-adapters.md)) is safe no matter how old that bundle is. Do not
let this section scare you off that pattern; the risk described above is specific to a linked source run
that was itself **executed**, and therefore holds `evidence`, before the bump.

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
