# Observed execution of a reviewed test suite

There are two ways a test result can satisfy a **Coverage Obligation**, and both require the QA Runtime to have watched the run itself.

- **Lane 1** — the runtime drives the browser over a bounded Test DSL and registers one `test-result` per attempt. This is what `browser-test-executor` and the public workflow do.
- **Lane 2** — the runtime starts your own committed Playwright suite as a child process, captures its exit status and JSON report, and registers one `test-result-batch` for the whole run. This is `qa-skill execute playwright`.

A result file simply handed to the runtime is an **Agent Draft**: reportable, never coverage-crediting, however much evidence accompanies it.

## The command

```sh
qa-skill execute playwright --root . --run-id <id> --spec-dir specs -- --workers=1 --grep smoke
```

Everything after `--` reaches the runner verbatim. `--reporter` and `--output` are runtime-owned and refused rather than silently overridden — the runtime pins a JSON reporter and an output directory outside your spec tree.

`--root` is the project root: the Run Workspace's root, the runner's working directory, and the directory the git repository is discovered from. The command targets an existing run, so create one first (`qa-skill run create --root . --mode execute --environment-file environment.json`) and register the test cases and coverage obligations the suite is meant to satisfy. Production gating is read from the run's registered `environment-profile`, not from a flag: a `production` classification refuses unless the profile sets `productionReadOnly`.

On success it prints one JSON line with the `executionId`, the registered batch and evidence artifact IDs, the `commitSha` and `specTreeSha256` that were anchored, the runner's `exitCode`, how many entries were carried, every spec that was **excluded**, and `runnerWorkingDir` — the temporary directory holding the runner's verbatim `report.json` and its `artifacts/` (traces, screenshots, whatever `attachments[].path` pointed at). `runnerWorkingDir` is omitted in the rare case that the report declared no project at all. That directory is the only place a failure message survives, so keep the line if you may need to diagnose a failing entry.

## Tagging a spec so it earns coverage credit

Put the identity tag `[qa:<testCaseId>/<revisionId>/<instanceId>@<surface>]` in the `test(...)` title:

```js
test('the ledger balances [qa:TC-LEDGER/REV-1/INST-1@api]', async ({ request }) => { /* … */ });
```

The four components are the registered test case's `testCaseId`, its `revisionId`, its `instanceId`, and the **Execution Surface** the spec really exercises. Copy the three identity values out of the registered `test-case` artifact (`qa-results/<run-id>/inputs/<id>-test-case.json`) rather than computing them: `revisionId` is a content fingerprint and `instanceId` additionally folds in the parameter set and browser the case was expanded for, so a hand-derived value will not match and the spec will simply be excluded.

The tag lives in the spec tree on purpose. It is covered by the batch's own `specTreeSha256`, so whoever merged the spec reviewed the claim it makes. A `--surface` flag would sit outside the anchor, where it could be changed without dirtying the tree.

Titles of enclosing `describe` blocks are not searched — only the leaf title belongs to the test that ran.

### Which surfaces lane 2 may claim

`api`, `unit`, `integration`, `performance`, `security`.

**`browser` is refused, and the message says so.** A browser entry is required to record the engine and the viewport it ran at, and Playwright's JSON reporter exposes neither — `projectName: "chromium"` is a label you chose in your config, not an observation. Rather than synthesise them, the runtime follows the domain model: it executes the browser surface itself (lane 1) and reaches every other surface through an observed execution. Retag the spec with the surface it really exercises, or run that case through lane 1.

`manual` is refused too: a human's evaluation has no spec tree to hash. Record one with `qa-skill attestation record`.

### Excluded versus refused

- **Excluded** — a spec with no tag, or a tag naming a test case this run never registered. It is listed in the command's output with the reason, and the run continues. An external suite legitimately holds specs this QA Run never planned, and a batch entry must match exactly one registered test case, so such a spec cannot be carried at all.
- **Refused** — the whole command fails and nothing is registered: a tag matching more than one registered test case (the workspace cannot tell which case ran), a malformed or unsupported tag, a runner result status the runtime cannot classify, or a run in which nothing resolved.

## What the anchor refuses, before anything is started

`commitSha` and `specTreeSha256` are resolved **before** the runner process starts, and a refusal from that resolution means no process starts at all. A Reviewed Test Suite whose working tree differs from its recorded commit produces no observed execution — there is no `--allow-dirty`, because the artifact that carries the anchor is immutable and would otherwise record a commit identity describing a tree that is not the tree that ran.

Refused, each naming the offending paths:

- **A dirty spec directory** — any modified, untracked, **or gitignored** file under `--spec-dir`. Exits `2` (blocked), not `3`.
- **A repo-root `--spec-dir`** — in a real project this essentially always refuses, because `node_modules/` is ignored and therefore listed. Point `--spec-dir` at the directory holding your specs.
- **A sparse checkout** — sparse checkout sets `--skip-worktree` on every path outside the cone, and an index-flagged entry hides working-tree edits from the dirty check while its bytes would still enter the digest. Clear the flag (`git update-index --no-skip-worktree`) or widen the cone; the runtime never clears it for you.
- **An `--assume-unchanged` entry**, for the same reason.
- **A submodule or a tracked symlink** inside the spec directory — its contents are not covered by the digest, and following one out of the repository would fold in content no commit can reproduce.
- **No tracked files** under the spec directory, no git repository, or no commit at `HEAD`.

### The report must place every spec inside `--spec-dir`

**Every spec file the runner's report names is checked against the anchored directory, and one outside refuses the whole run.** The anchor covers `--spec-dir` and nothing else, but the runner is not otherwise confined to it: `--config` reaches the runner verbatim like every other argument after `--`, and an ordinary `playwright.config` may simply declare a `testDir` broader than `--spec-dir`. Without the check, specs the spec-tree checksum never hashed — including files no human reviewed — would be reported as executed and earn coverage credit under an anchor that claims to describe them.

The offending files are named. The usual cause is a `testDir` broader than `--spec-dir`, and the fix is to narrow the suite (a narrower `testDir`, or positional filters after `--`) or to point `--spec-dir` at the directory that really runs. Containment is judged on physical paths, so `specs2/` does not satisfy `specs/` and a symlink out of the tree does not either. The offending entries are not merely dropped: the anchor is a statement about the execution as a unit, so one unanchored spec falsifies it for every entry. Nothing is registered when this refuses.

### The anchor must still hold when the runner exits

**The anchor is resolved a second time after the runner exits, and a run whose spec tree moved underneath it is refused.** The first resolution is a snapshot taken before anything is spawned; nothing re-reads the tree until the process is gone. In between, code the anchor does not cover has write access to it — a `globalTeardown`, a `globalSetup`, a config-level `process.on("exit")` hook — so bytes can change while `specTreeSha256` still records the bytes that were there before. Two shapes, one refusal: the second resolution simply refuses (the ordinary case: the write leaves the tree dirty), or it succeeds with a different `commitSha`/`specTreeSha256` while the tree reads clean. Both halves of that second shape are independently reachable — a run that commits its own change moves `commitSha`, and swapping the spec directory for a symlink to another tracked directory moves `specTreeSha256` alone — so both are compared.

This one is a containment denial, not housekeeping, and exits `4` rather than the `2` a dirty tree exits before a run: re-running unchanged does not clear it. It also means a run that writes into its own spec directory fails immediately instead of only poisoning the next one — see the consequences below.

What it does not catch, said plainly: an edit applied and reverted inside the same run leaves both snapshots equal.

### What lane 2 proves, and what it does not

Read this before you describe lane 2 to anyone.

The runtime resolves the runner binary itself, pins the reporter, spawns the process, captures its exit status and output, and re-checks the anchor. That is the whole `runtime-observed` claim, and it is what separates a batch from a report file an agent hands over.

**The per-spec results, however, are read out of the JSON report that same process wrote.** The runtime tells the runner where to write it and reads back whatever is at that path; there is no signature, no nonce and no integrity check, because the reporter that writes the file is a module loaded inside the process being observed. Everything else loaded there can be outside the anchor too — `playwright.config`, a `--config` after `--`, `globalSetup`/`globalTeardown`, fixtures, every helper any of them imports. Nothing requires any of it to live under `--spec-dir`, and an ordinary project's config sits at the repository root; whatever part of it does live outside is absent from `specTreeSha256`, need not be committed at all, and still runs with the runtime's trust. The digest covers every tracked file under `--spec-dir` rather than only `*.spec.*` files, so a fixture you keep inside the spec directory *is* anchored — it is the code outside that the anchor cannot reach. A config that installs an exit hook over the report file can turn a failing anchored spec into a passing entry, and every check that reads the report accepts it, because everything they read is what that hook wrote. The two anchor checks do not fire on it either — they read git, and a forged report leaves the spec tree untouched.

So: a batch binds a committed, human-merged spec tree — proven to have still been standing when the runner exited — to an execution this runtime started and whose exit it saw. It does not certify that those bytes, and only those, produced each recorded status. That is inherent to observing an external runner rather than interpreting it, and it is stated here rather than implied away. Do not describe lane 2 as proving that the anchored specs are what ran.

### Two consequences worth planning for

Your spec directory must hold spec sources only: anything a run leaves under it — `test-results/`, `playwright-report/`, an `.auth/` storage state — refuses the run that wrote it and every run after. The runtime forces the runner's own artifact directory and JSON report outside the repository so its output cannot do that, but it cannot move a path your own config or `globalSetup` writes to; point those outside the spec directory yourself.

And the anchor covers files, not the import graph: a tracked spec that imports a helper from outside the spec directory still executes code the digest does not cover.

## What the run records

- One `test-result-batch`, stamped `runtime-observed`, carrying the anchor and one entry per identified spec — one entry per project the spec ran under. An entry's status comes from the runner's last reported result for that test: `passed` → `PASSED`, `failed` and `timedOut` → `FAILED`, `skipped` → `NOT_RUN`, `interrupted` → `BLOCKED`. The runtime never diagnoses a cause, so every non-passing entry is `UNDETERMINED` — a product-versus-test-defect judgement is a person's, made later.
- One `runner-report` Evidence Item, whose subject is the observed execution rather than any attempt. Every non-passing entry cites it; a passed entry must not, and the contract rejects a batch where one does.

**The registered evidence is a sanitized projection of the reporter's output, not the file the runner wrote.** That file carries the whole command line and, for an ordinary web project, the resolved environment your `webServer` block passes through — and a resolved secret must never enter an artifact.

The payload discloses its own removals in a `sanitization` block, and they are: `config.argv`, `config.metadata`, `config.webServer`, each project's `metadata` and `outputDir`; the top-level `errors`; a spec's `tags`; a test's `annotations`; and each result's `error`, `errors`, `errorLocation`, `stdout`, `stderr`, `annotations`, `attachments` and `steps`. What survives is the identity and shape of the run: the config's version, paths and worker settings; the run stats; and each suite, spec, test and result with its title, location, project, status, duration, retry and start time.

**So the artifact records which spec ran and how it ended, but not why it failed.** That is a deliberate cost, not an oversight: redaction needs the resolved secret values to scrub and this producer never learns them — they belong to the external suite's own process — so the dropped fields are the ones carrying run-time output or caller-authored configuration rather than reviewed spec-tree content. The runner's verbatim report is still on disk, in the `runnerWorkingDir` the command prints, if you need to read it; it is simply never registered.

## Reporting

A run credited entirely by a batch reaches a release gate exactly like a lane-1 run: `execute` and `full` accept a `test-result-batch` wherever they accept a `test-result`, the gate credits each entry against the obligations its surface matches, and the QA report counts the entries. `regression` accepts a batch as its execution record too, and a selection lane 2 covered entirely legitimately drives nothing — the union-coverage check is what keeps that honest, since a selected case covered by neither lane still invalidates the run (`src/core/inspect-workspace-state.ts`). `retest` still requires a lane-1 attempt, and the reason is structural rather than scheduling: `retest-result` binds every reproduction scenario to a `sourceAttemptArtifactId` and an `attemptId` (`shared/schemas/retest-result.schema.json`), and a batch entry has neither — it is keyed by `entryId` precisely because no attempt was driven (`shared/schemas/test-result-batch.schema.json`). So a retest's reproduction is lane-1 by construction.
