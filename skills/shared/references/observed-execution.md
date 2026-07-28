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

On success it prints one JSON line with the `executionId`, the registered batch and evidence artifact IDs, the `commitSha` and `specTreeSha256` that were anchored, the runner's `exitCode`, how many entries were carried, and every spec that was **excluded**.

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

Two consequences worth planning for. Your spec directory must hold spec sources only: anything a run leaves under it — `test-results/`, `playwright-report/`, an `.auth/` storage state — makes every later run refuse. The runtime forces the runner's own artifact directory and JSON report outside the repository so its output cannot do that, but it cannot move a path your own config or `globalSetup` writes to; point those outside the spec directory yourself. And the anchor covers files, not the import graph: a tracked spec that imports a helper from outside the spec directory still executes code the digest does not cover.

## What the run records

- One `test-result-batch`, stamped `runtime-observed`, carrying the anchor and one entry per identified spec — one entry per project the spec ran under. An entry's status comes from the runner's last reported result for that test: `passed` → `PASSED`, `failed` and `timedOut` → `FAILED`, `skipped` → `NOT_RUN`, `interrupted` → `BLOCKED`. The runtime never diagnoses a cause, so every non-passing entry is `UNDETERMINED` — a product-versus-test-defect judgement is a person's, made later.
- One `runner-report` Evidence Item, whose subject is the observed execution rather than any attempt. Every non-passing entry cites it; a passed entry must not, and the contract rejects a batch where one does.

**The registered evidence is a sanitized projection of the reporter's output, not the file the runner wrote.** That file carries the whole command line and, for an ordinary web project, the resolved environment your `webServer` block passes through — and a resolved secret must never enter an artifact.

The payload discloses its own removals in a `sanitization` block, and they are: `config.argv`, `config.metadata`, `config.webServer`, each project's `metadata` and `outputDir`; the top-level `errors`; a spec's `tags`; a test's `annotations`; and each result's `error`, `errors`, `errorLocation`, `stdout`, `stderr`, `annotations`, `attachments` and `steps`. What survives is the identity and shape of the run: the config's version, paths and worker settings; the run stats; and each suite, spec, test and result with its title, location, project, status, duration, retry and start time.

**So the artifact records which spec ran and how it ended, but not why it failed.** That is a deliberate cost, not an oversight: redaction needs the resolved secret values to scrub and this producer never learns them — they belong to the external suite's own process — so the dropped fields are the ones carrying run-time output or caller-authored configuration rather than reviewed spec-tree content. The runner's verbatim report is still on disk in the runtime's temporary working directory if you need to read it; it is simply never registered.

## Reporting

A run credited entirely by a batch reaches a release gate exactly like a lane-1 run: `execute` and `full` accept a `test-result-batch` wherever they accept a `test-result`, the gate credits each entry against the obligations its surface matches, and the QA report counts the entries. `retest` and `regression` still require lane-1 attempts.
