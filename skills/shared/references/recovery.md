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
