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
4. `outcome === "AWAITING_HUMAN_INPUT"` (waiting on a person) → `2` (`BLOCKED`)
5. `validation.valid === false` → `1` (`UNMET_OBLIGATIONS`)
6. `releaseRecommendation === "NOT_READY"` → `1` (`UNMET_OBLIGATIONS`)
7. `outcome === "COMPLETED_WITH_FAILURES"` → `1` (`UNMET_OBLIGATIONS`)
8. otherwise → `0` (`SUCCESS`)

Both non-terminal outcomes resolve **ahead of** `validation.valid`, and that ordering is load-bearing: a
paused run legitimately has not yet registered the artifacts its profile requires, so collapsing it into
`UNMET_OBLIGATIONS` would report an unmet obligation where the truth is "not finished yet".

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

## `AWAITING_HUMAN_INPUT`

`outcome: "AWAITING_HUMAN_INPUT"` means the workflow ran every operation it could and then **stopped in
front of one that needs an artifact only a person can write**. Two exist, and the run stops immediately
before the operation each one gates:

| What is missing | Command | The run stops before | Modes |
| --- | --- | --- | --- |
| An approval for a `human-review` test plan | `qa-skill approval record` | `execute-browser-test` | `full`, `execute`, `regression` |
| A Human Attestation for a required manual Accessibility Obligation | `qa-skill attestation record` | `generate-qa-report` | `full`, `regression` |

`retest` is deliberately absent from the first row. Its bundle's own reproduction scenarios run through
`reproduce-bug`, which drives the browser **before** `execute-browser-test` and is not guarded by this
pause at all — a `human-review` plan on one of them still throws, exactly as before this mechanism
landed. See [One known gap](#one-known-gap) below.

Like `AWAITING_RUNTIME` this is **not a failure and not a terminal run**. Nothing was finalized, no
`release-gate` was written, the process lock is released, and — the point of the whole mechanism — the
workspace is still **writable**, which is what lets the command below register into it. Exit code `2`
(`BLOCKED`).

The result body tells you what to do. Alongside `outcome` it carries `pendingHumanInput`:

```json
{
  "kind": "attestation",
  "operation": "generate-qa-report",
  "command": "attestation record",
  "reason": "The release gate requires a Human Attestation for a required manual accessibility obligation.",
  "subjects": [
    { "artifactId": "ART-…", "sha256": "…", "reference": "COV-A11Y", "method": "keyboard" }
  ]
}
```

`subjects[].reference` is the value the command names the artifact by — `--plan-artifact-id` for an
approval (where it is the artifact id itself), `--obligation-id` for an attestation. `method` is the
`--method` that attestation must carry; any other is refused.

**The recovery procedure is three steps:**

1. Read `runId` and `pendingHumanInput` from the JSON body.
2. Have the identified person run the named command against that `runId` — for example
   `qa-skill attestation record --root <path> --run-id <runId> --obligation-id COV-A11Y --method keyboard --attested-by <identity> --statement "<what you actually did and observed>"`.
3. Re-run `qa-skill workflow run` with the **same** input file plus `"resumeRunId": "<runId>"`. The
   workflow reopens the same run, skips every completed operation from its `workflow-checkpoint`, and
   re-evaluates the same condition at the operation it stopped at.

Resuming without recording anything is safe and does nothing: the run pauses again with the identical
`pendingHumanInput`, registers no new artifact, and re-executes no operation. Resuming after recording
continues to the end. There is no separate resume path — this is the same `resumeRunId` machinery
`AWAITING_RUNTIME` uses.

A `full` run that needs **both** kinds of record does not surface them together: `pendingHumanInput` is a
single object, and the attestation pause is only reachable after a resume has carried the run past
`execute-browser-test` (obligations are read at `generate-qa-report`, the second guarded operation). So
recording the approval and resuming can itself return a second, different `AWAITING_HUMAN_INPUT` — this
time for the attestation — rather than finishing; repeat the same three-step procedure for it before the
run completes.

### What does *not* pause — and must not

A pause says "a person can fix this right now". It is deliberately **narrower** than "something is
unsatisfied", because pausing on something nobody can resolve would turn an honest verdict into an
indefinite hang. None of the following pauses; each reaches the gate and is reported there:

- **An Execution Surface this run did not execute.** `api`, `unit`, `integration`, `performance` and
  `security` are reachable — through a Runtime-Observed Execution (`qa-skill execute playwright`,
  lane 2) — but reachable is not the same as run: an obligation on one of them stays unmet until a run
  actually observes a spec tagged with that surface, and the runtime cannot write and merge that spec
  for you. `manual` has no executor in either lane at all. Either way there is nothing a person can do
  in the next minute that this run would then pick up, so it stays explicitly unmet → `NOT_READY`.
- **A `manual` obligation declaring no accessibility method.** Nothing can satisfy it: no attempt is
  ever produced on that surface, and no Human Attestation can bind it either — the attestation contract
  admits only `keyboard`, `screen-reader` and `cognitive-manual`, and requires the obligation to declare
  the same method → `NOT_READY`. An obligation that DOES declare one of those three is an Accessibility
  Obligation and *does* pause — that is the attestation case above, and it turns on the method, not on
  the surface, so it pauses on whatever surface the obligation names.
- **`accessibilityMethod: "automated-analysis"`.** Only a machine-produced analysis could satisfy it and
  no scanner ships here; a person attesting to it is a category error the command itself refuses →
  `NOT_READY`.
- **An obligation whose requirement is not `AUTHORITATIVE`.** Coverage credit requires an authoritative
  requirement, so an attestation would be recorded and still not clear it → `NOT_READY`.
- **An optional obligation** (`required: false`). It is reported as an optional gap →
  `READY_WITH_RISKS`, which is an honest "not covered".
- **Two registered obligations sharing one `obligationId`.** `attestation record` refuses an ambiguous
  id, so pausing would name a command that cannot run → `NOT_READY`.
- **A plan no approval can rescue.** `qa-skill approval record` resolves only a plan whose
  `approvalPolicy.mode` is `human-review` and whose derived decision is a pending `HUMAN_REVIEW`. A test
  case bound to no plan at all is refused by `execute-browser-test` as before
  ("Test case plan binding is not approved"), which is retained as the last line of defence for callers
  that bypass the workflow.

If you see `NOT_READY` for one of these, there is nothing to recover: the runtime is refusing to credit
an obligation nobody witnessed. Either supply the missing capability, or author the obligation with
`required: false` so it records "not covered" honestly instead of blocking.

### One known gap

`retest` mode runs `reproduce-bug` **before** `execute-browser-test`, and `reproduce-bug` drives the
browser too. The approval pause guards `execute-browser-test` only, so a `human-review` plan in a
`retest` bundle still throws at `reproduce-bug` ("Test case plan binding is not approved") rather than
pausing. That is unchanged from before this mechanism landed, not a regression it introduced — but it
means a retest bundle should carry an `auto-approve-safe` plan.

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
`evidence` went `2.0.0` → `3.0.0`), and artifacts written by an older version of the package stop
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
`evidence` artifact written before the `3.0.0` bump, all four of these flows fail, and they fail while
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
it writes fresh `evidence` at `3.0.0`, then retest, regress, or compare against that new run instead.

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

## Attestation, approval, and the gate: where the run stops

**There is no `qa-skill report generate` command.** Earlier revisions of this reference and of
[artifact-authoring](./artifact-authoring.md) named one; it never existed. The commands this CLI
actually has are `init`, `run create`, `skills list|install|verify|update|uninstall`,
`workflow run|scaffold|bootstrap`, `runtime verify`, `schema show`, `draft init`, `fingerprint`,
`artifact ingest`, `approval record`, `attestation record`, and `validate` (`src/cli/program.ts`). The
`release-gate` and `qa-execution-report` artifacts are written by the `generate-qa-report` **operation**,
which runs only inside `qa-skill workflow run`, and only in `full` and `regression` modes
(`src/core/modes.ts`).

An earlier revision of this section said `qa-skill attestation record` had **no reachable position in a
shipped workflow**, and that the human checkpoint was deferred Phase 7 work. That was true when it was
written and is now false: the checkpoint landed, and the same mechanism also gave
`qa-skill approval record` the position it had silently been missing since it shipped. See
[`AWAITING_HUMAN_INPUT`](#awaiting_human_input) above for the full procedure. The one-paragraph version:

- `qa-skill workflow run` no longer finalizes in a single invocation whenever a human record is due. It
  stops **immediately before** the operation the missing record gates — `execute-browser-test` for an
  approval, `generate-qa-report` for an attestation — and returns `AWAITING_HUMAN_INPUT` without
  writing a gate and without finalizing, leaving the run non-terminal and the workspace writable.
- The person records the artifact against that `runId`, and the same input file plus
  `"resumeRunId": "<runId>"` continues the run from its `workflow-checkpoint`.
- **Ordering is why the stop is where it is.** A release gate is an immutable snapshot: it is
  re-derived from, and checked against, every non-gate/non-report artifact registered in the run at
  read time (`releaseGateRule` in `src/core/semantic-rules.ts`). Registering a `human-attestation`
  *after* the gate exists changes what that re-derivation produces, so the persisted gate no longer
  equals its own re-derivation and the next read invalidates it with `ARTIFACT_BINDING`. There is no
  regenerate-in-place fix — `generateQaReport` refuses to run a second time in one run, by design — so
  the pause has to sit in front of `generate-qa-report`, and it does.

What has **not** changed:

- Staging an attestation in a bootstrap run still does not carry it forward. `qa-skill workflow
  bootstrap` finalizes its `plan` run, and `human-attestation` is not one of the four canonical planning
  types, so a bundle import will not bring it across and `workflow scaffold` rejects a source run that
  holds one. Record it in the run that will produce the gate, at the pause.
- `qa-skill run create` still gives a non-terminal run that accepts an ingested `coverage-obligation`
  and an attestation against it, and nothing generates a gate for a run built that way. Use
  `qa-skill workflow run`.
- An obligation that no command can satisfy still reaches the gate as `NOT_READY` rather than pausing.
  The list is under
  [What does *not* pause](#what-does-not-pause--and-must-not).

## Check the JSON body, not just the exit code

`WorkflowResult` (returned by `qaTester()` / `createQaTester()`, and printed as JSON by
`qa-skill workflow run`) carries four fields that matter more than the exit code:

- `outcome`: `"AWAITING_RUNTIME" | "AWAITING_HUMAN_INPUT" | "COMPLETED" | "COMPLETED_WITH_FAILURES" |
  "BLOCKED" | "ABORTED"`
- `validation`: `{ valid: boolean, diagnostics: [...] }`
- `releaseRecommendation` (registered when the `generate-qa-report` operation runs — `full` and
  `regression` modes; not `plan`, `execute`, `exploratory`, or `retest`): `"READY" | "READY_WITH_RISKS" |
  "NOT_READY"`
- `pendingHumanInput` (present only with `outcome: "AWAITING_HUMAN_INPUT"`): what to record, and for
  which artifact — see [`AWAITING_HUMAN_INPUT`](#awaiting_human_input)

The process exit code **collapses distinct situations together**. Exit code `1` alone does not tell you
whether the gate said "not ready" (`releaseRecommendation === "NOT_READY"`, with `validation.valid ===
true` — every structural obligation was met, and the *content* of the run does not clear the release
bar) or whether validation itself failed (`validation.valid === false` — a structural obligation is
unmet, and no release verdict was even reached). Exit code `2` alone does not tell you whether the
workflow is genuinely `BLOCKED`, is `AWAITING_RUNTIME` and simply needs a runtime registry and a
resume, or is `AWAITING_HUMAN_INPUT` and needs a named person to record one artifact before the same
resume finishes it.

Before reporting success or failure to the user, read `outcome`, `validation.valid` (and its
`diagnostics` when invalid), and `releaseRecommendation` from the JSON body. Do not infer the situation
from the exit code alone.

## `qa-skill export`

```
qa-skill export --root <path> --run-id <id> --format junit|sarif --out <path>
```

Projects a **finalized** run's already-persisted release gate into a JUnit XML or SARIF 2.1.0 file for
CI, and writes a provenance sidecar to `<out>.provenance.json` (`src/operations/export-projection.ts`).
No second gate derivation happens here: the gate this projects is the one `readRegisteredArtifacts()`
already verified when it opened the run (`run-workspace.ts:448-450` throws `ARTIFACT_BINDING` on any
diagnostic) — re-deriving it a second time to cross-check would repeat the exact defect the
`VALID_ARTIFACTS` incident records, one call site later.

Exit codes (`src/cli/exit-codes.ts`; the command's own action is `src/cli/program.ts:277-295`, the
catch-all mapping is `program.ts:298-341`):

- **`0` `SUCCESS`** — the projection and sidecar were written. This includes a `NOT_READY` gate:
  exporting succeeded, and the verdict is on `recommendation` in the printed JSON and in the sidecar,
  never on the exit code. `qa-skill workflow run` is the command that carries a `NOT_READY` gate as its
  own exit `1` (`exit-codes.ts:39`); `export` deliberately does not repeat that meaning on a second
  command — one exit code with two meanings would be worse than two commands with one each.
- **`3` `INVALID_INPUT`** — a refusal. Every `QaSkillsError` this command can throw carries a code other
  than `LIVE_LOCK`/`SPEC_TREE_DIRTY` or the `SAFETY_DENIED` set, so all of them fall to the catch-all's
  `else` branch (`program.ts:325`). Four distinct causes land here:
  - an unsupported `--format` — anything but exactly `junit` or `sarif` (`export-projection.ts:186`).
  - a run with **no release gate** — only a finalized `full` or `regression` run registers one; `plan`,
    `execute`, `exploratory`, and `retest` runs never do (`projection-model.ts:138`).
  - an `--out` (or its derived `<out>.provenance.json` sidecar) that **resolves inside the results
    root** — a run workspace is closed and checksummed, and a file landing under any run's `inputs/` or
    `evidence/` either invalidates a registered artifact (`CHECKSUM_MISMATCH`, forever) or orphans the
    run (`ORPHAN_FILE`) (`export-projection.ts:153`). Both outputs are checked against the whole results
    root, symlinks resolved — not just `--out` alone. `assertOutputsAreOutsideTheRuns` is a sequential
    loop over the two candidates that throws on the first failing one it finds, not a check of both at
    once (`export-projection.ts:141-156`) — but the guarantee that actually matters holds regardless:
    that loop runs to completion, or throws, **before either the projection or the sidecar is written**
    (`export-projection.ts:191-199`). A projection written and then a refused sidecar would leave a file
    on disk that nothing vouches for — the exact state the sidecar exists to make impossible.
    **What this refusal does not cover, stated so an operator is not misled about it:** the guard
    resolves *symlinks*, and a **hard link** at either output path defeats it — `realpath` has no target
    to follow for one, so a path whose inode *is* a registered artifact reads as outside the results root
    and `writeFile`'s `O_TRUNC` overwrites it in place, leaving that run `CHECKSUM_MISMATCH` forever
    while the export exits `0`. Confirmed by execution; it needs the output placed on the same
    filesystem as the run. A filed follow-up moves the containment check to open time (`O_NOFOLLOW` plus
    an `fstat` rejecting `nlink > 1` on the descriptor about to be written), which is also what closes
    the window between this check and the writes. Until then, write projections to a directory a
    would-be attacker cannot pre-populate.
  - an `--out` (or its sidecar) **whose destination cannot be resolved at all** — a dangling symlink or a
    symlink loop (`export-projection.ts:150`). This is a deliberate refusal, not a bug: the guard's job
    is to *prove* the write lands outside the runs, and "I could not work out where this goes" is not a
    proof. It has a real availability cost — an `--out` that used to be a symlink to a not-yet-created
    file *outside* `qa-results/` worked before this guard existed and refuses now — but failing open
    would cost a run instead of a write.
- **`5` `ABORTED_OR_INTERNAL`** — a `--run-id` that does not exist. `RunWorkspace.open` calls `realpath`
  on the run's resolved path unguarded (`run-workspace.ts:137-139`), and `assertRealpathWithin` reaches a
  bare `realpath` on a path that does not exist (`core/fs.ts:128-130`), which raises a raw Node `ENOENT`
  — not a `QaSkillsError` — so the catch-all's fallback maps it to `ABORTED_OR_INTERNAL`
  (`program.ts:340`), not `INVALID_INPUT`. **This is not a quirk of `export`**: `validate`, `approval
  record`, and `attestation record` all behave identically, and `execute-observed-playwright.ts:343-346`
  already states the ruling for the whole family — a `--root`/`--run-id` pair that does not resolve
  surfaces as the raw filesystem error `RunWorkspace.open`'s `realpath` throws. A filed follow-up tracks
  giving `RunWorkspace.open` its own typed refusal for a missing run; special-casing `export` alone to
  answer `3` here would put one command out of step with every sibling that opens a run.
- **`2` `BLOCKED`** — reachable the same way every other run-scoped command reaches it, not through
  anything specific to exporting. `RunWorkspace.open` acquires a process lock for any run that is not yet
  terminal (`run-workspace.ts:144`), and a genuinely live second process already holding that lock raises
  `LIVE_LOCK` (`core/run-lock.ts:46`), which the catch-all maps to `BLOCKED` (`program.ts:321`). A
  finalized run never takes this path — `open` never acquires a lock for one — so this is only reachable
  by exporting a run that is still mid-execution while another process has it open; wait for that process
  to finish or stop it, per [Live lock](#live-lock-live_lock) above.

An agent producing CI artifacts from only this bundle needs one call per format, against the same
finalized `--run-id`:

```bash
qa-skill export --root <path> --run-id <id> --format junit --out qa-junit.xml
qa-skill export --root <path> --run-id <id> --format sarif --out qa.sarif
```

Both calls succeed or refuse identically for the same run — the only difference is the file each
renders. See [Consuming the gate in CI](../../../README.md#consuming-the-gate-in-ci) in the README for
the sidecar's contents, the reduced-projection behavior under a protected environment, and why a SARIF
result can carry no `locations`.
