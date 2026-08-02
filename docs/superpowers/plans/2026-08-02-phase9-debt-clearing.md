# Phase 9 — clearing the carry-forward debt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every carry-forward item filed since Phase 3 and never returned to, so the v1.0 decision is taken against a clean list.

**Architecture:** No features. Six groups, each one reviewable unit: a schema bump that makes the colon-collision class unrepresentable, then identity, exit-code honesty, gate honesty, test gaps, and platform. The bump lands first and alone because every later group's fixtures are written against the new versions.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest, Commander, `ajv`, JSON Schema — all already present.

Spec: `docs/superpowers/specs/2026-08-02-phase9-debt-clearing-design.md`. Inventory with `file:line` for every item: `.superpowers/sdd/debt-inventory.md`. Baseline: `main` @ `fb1a3dd`.
Branch: `feat/phase9-debt-clearing` off that commit (project convention: branch + FF-merge, as phases 3–8b did).

## Global Constraints

- **TDD, always.** Write the test, RUN it, paste the real failure into the task report, then implement.
- **Every test proven by mutation:** delete or invert the line it covers, watch it go red, restore. Report each mutation and its observed failure. A test that passes with the feature removed is not a test.
- **No new runtime dependency. No new exit code. No new artifact type.** Schema changes are confined to Task 1.
- ESM: every relative import ends in `.js`. No snapshots (`toMatchSnapshot`/`toMatchInlineSnapshot` must stay at zero in `tests/`).
- **Comments citing another file name the FILE, not a line number.** This project has been bitten five times by line-citation rot.
- **`git add` BEFORE `npm run scan:secrets`.** The scanner walks `git ls-files`; this project has twice recorded a passing scan that was spurious because a file was untracked.
- **Never background a gate command and end your turn** — nothing resumes you.
- **Do not run `tests/cli/workflow-modes.test.ts` or `tests/e2e/lane2-batch-credited-run.test.ts` in isolation while iterating.** They launch real Chromium and a Playwright runner; three review subagents on this project have been killed after stalling 600 s on that. The full gate runs them once.
- **The full gate is nine commands, from a deleted `dist/`:**
  ```bash
  rm -rf dist
  npm run generate:types && npm run check:generated && npm run typecheck && npm run lint \
    && npm run check:examples && npm run test:coverage && npm run build \
    && npm run scan:secrets && npm run smoke:package
  ```
  Coverage floor 90/80/95/90. Baseline at `fb1a3dd`: 1299/1299 tests (90 files), coverage 94.32/84.52/98.19/94.32.
- Conventional commit prefix; every message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

---

## File structure

| File | Group | Responsibility |
|---|---|---|
| `shared/schemas/{test-case,test-result,test-result-batch,coverage-obligation,evidence-gap,human-attestation}.schema.json` | 1 | `pattern` on identity fields; `schemaVersion` const bump |
| `src/contracts/generated/*.d.ts` | 1 | regenerated, never hand-edited |
| `src/operations/run-workflow.ts` | 2,3,4 | retest `:`-join; `retest.sourceBug` guard; the two unscoped readers |
| `src/core/inspect-workspace-state.ts` | 2 | `executionCaseRefs` dedup |
| `src/core/run-workspace.ts` | 3 | `realpath` wrap — one fix, nine call sites |
| `src/regression/change-scope.ts` | 3 | three bare `Error`s → `QaSkillsError` |
| `src/reporting/release-gate.ts` | 4 | D9 fail-closed; delete the dead parameter |
| `src/core/observed-coverage.ts` | 4 | one new selection-scoped question |
| `src/operations/export-projection.ts`, `src/reporting/projections/sarif.ts` | 5 | count location-less SARIF results |
| `src/installer/agents.ts` | 6 | `PATHEXT` |
| `.github/workflows/ci.yml` | 6 | widen the Windows selection |
| `src/installer/manifest.ts` consumers (15 files) | 6 | `producerVersion` from `runtimeVersion` |

---

### Task 1: The schema bumps, alone

**Files:**
- Modify: the six schemas listed above
- Modify: `src/contracts/types.ts:64` and `src/evidence/redaction.ts:3` — hand-written literals the generator does NOT produce
- Modify: `examples/sample-testcase.yaml:2`, `examples/sample-result.json:3`, `scripts/run-demo.ts:121,133`, `skills/shared/references/artifact-authoring.md:156,256`
- Modify: ~103 fixture literals across `tests/` and `src/` (per-type counts below)
- Test: `tests/contracts/validator.test.ts`

**Interfaces:**
- Produces: the new `schemaVersion` values every later task's fixtures must use — `test-case` **3.0.0**, `test-result` **3.0.0**, `test-result-batch` **4.0.0**, `coverage-obligation` **4.0.0**, `evidence-gap` **2.0.0**, `human-attestation` **2.0.0**.

**Nothing else goes in this task.** A reviewer reading a hundred-line mechanical diff must not also be judging logic.

**Per-type fixture counts, measured — use these to check your own completeness:** test-case 35, coverage-obligation 28, test-result 15, evidence-gap 10 lines/11 literals, test-result-batch 9, human-attestation 6.

**Five traps a naive sweep hits. Each is a real site, not a hypothetical:**

1. **`grep '"1.0.0"'` misses `tests/core/run-workspace.test.ts:699`**, which writes YAML inside a `.join("\n")` array: `"schemaVersion: 1.0.0",` — unquoted, no `"1.0.0"` token.
2. **`shared/schemas/evidence-gap.schema.json:9` puts `evidenceGapId` on the SAME line as `artifactType`**, with `schemaVersion` on the line after. Anchoring on "the line after artifactType" gets the wrong line.
3. **`src/evidence/redaction.ts:3` carries TWO literals on one line** — it is a TS union *type* declaration, not a fixture.
4. **Three tests assert the NEW version is invalid, and will invert.** `tests/contracts/validator.test.ts:608` asserts `test-result-batch` `"4.0.0"` is invalid; `:927` asserts `human-attestation` `"2.0.0"` is invalid; `:839` asserts `coverage-obligation` `"2.0.0"` is invalid. Each must be re-pointed at the newly-superseded version, not deleted.
5. **`tests/evidence/collector.integration.test.ts:169` asserts `schemaVersion` is `"3.0.0"` on an `evidence` artifact** — NOT one of the six. Do not touch it.

- [ ] **Step 1: Decide the pattern, and record the decision**

The minimum that closes the collision class is forbidding `:`. Write it as `"pattern": "^[^:]+$"` alongside the existing `"minLength": 1`. Do NOT invent a stricter pattern: a stricter one risks refusing identities real users already have, and the collision is the only defect on record. State in your report that you chose the minimum and why.

- [ ] **Step 2: Write the failing rejection tests**

In `tests/contracts/validator.test.ts`, one per patterned field. This test IS the point of the whole task — it is what makes every reader-side fix redundant rather than load-bearing:

```ts
it("rejects a test case whose identity components could rejoin to another case's", () => {
  expect(validateArtifact("test-case", { ...testCase, instanceId: "A:B" }).valid).toBe(false);
  expect(validateArtifact("test-case", { ...testCase, revisionId: "R:A" }).valid).toBe(false);
  expect(validateArtifact("test-case", { ...testCase, testCaseId: "TC:X" }).valid).toBe(false);
});
```

Repeat for `test-result` (`testCaseId`, `testCaseRevisionId`, `testCaseInstanceId`), for a `test-result-batch` ENTRY's three fields, and for `coverage-obligation.obligationId`, `evidence-gap.evidenceGapId`, `human-attestation.obligationId`.

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run tests/contracts/validator.test.ts`
Expected: FAIL — each new case reports `valid: true`, because nothing constrains the charset yet. Paste the real output.

- [ ] **Step 4: Edit the six schemas**

Add the `pattern` to each field named in the spec's table, and bump each `schemaVersion` const to the value in the Interfaces block above.

- [ ] **Step 5: Regenerate types and see what moves**

Run: `npm run generate:types && git diff --stat src/contracts/generated`
Expected: six `.d.ts` files change. `src/contracts/generated/**` is ESLint-ignored, so only `check:generated` guards it — never hand-edit a generated file.

Then fix the two hand-written literals the generator does NOT produce: `src/contracts/types.ts:64` and `src/evidence/redaction.ts:3`.

- [ ] **Step 6: Sweep the fixtures**

Work per TYPE, not per literal string — the literals are shared across types. Disambiguate by the neighbouring `artifactType`. Use the counts above to check completeness, and re-read trap 1 before you believe a grep.

- [ ] **Step 7: Sweep outside `tests/` and `src/`**

`examples/sample-testcase.yaml:2`, `examples/sample-result.json:3` (both gated by `npm run check:examples`, which is in CI), `scripts/run-demo.ts:121,133`, and the shipped agent-facing docs `skills/shared/references/artifact-authoring.md:156,256`. `scripts/check-examples.ts` says in its own comment that a `schemaVersion` bump silently invalidated the shipped examples twice before that check existed.

- [ ] **Step 8: Re-point the three inverting assertions** (trap 4). Each should now assert the version it supersedes is invalid.

- [ ] **Step 9: Run the full gate**

- [ ] **Step 10: Prove the new tests by mutation**

Remove one `pattern` from each of the three schema families (identity, obligationId, evidenceGapId), watch the matching rejection test go red, restore. Record each.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat!: forbid a colon in the identity fields, closing the collision class at the data shape

The same colon-collision has now been fixed three times in three modules --
the observed-coverage reader, the checkpoint comparison, and the regression
decision store -- each at the reader side, while the data shape stayed free to
produce it. A fourth naive join was one commit away.

Six schemas bump because a pattern is a breaking change and the package is
pre-1.0: this is the last moment it costs a version bump rather than a
migration story.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Identity — the last join, and the dedup

**Files:**
- Modify: `src/operations/run-workflow.ts:1131,1138`
- Modify: `src/core/inspect-workspace-state.ts:471-475`
- Test: `tests/operations/observed-execution-residual.test.ts`, `tests/orchestration/runtime-public.e2e.test.ts`

**Interfaces:**
- Consumes: Task 1's new `schemaVersion` values in every fixture you write.

**Item 1.2 — the last `:`-join.** `run-workflow.ts:1131` and `:1138` build and probe a `Set` of joined identities in the `retest` branch of `select-regression`. Everywhere else in that same file uses the structural index. The idiom to copy is at `:1110-1111`:

```ts
const availableByIdentity = indexTestCasesByIdentity(available);
const exact = source.scenarios.map((scenario) => availableByIdentity.get({ testCaseId: scenario.testCaseId, testCaseRevisionId: scenario.revisionId, testCaseInstanceId: scenario.instanceId })[0]);
```

Three traps: the probe spells the trailing components `testCaseRevisionId`/`testCaseInstanceId` while a `test-case` payload spells them `revisionId`/`instanceId`, and the reconciliation lives only in `testCaseIdentityOf` (`:207-209`); `.get()` returns the whole bucket (`readonly T[]`), never one value; and `src/core/artifact-index.ts` explicitly forbids the join idiom these two lines use, on collision grounds.

**Item 1.3 — the dedup.** `inspect-workspace-state.ts:471-475` builds `executionCaseRefs` with no dedup while the left side of the comparison is duplicate-free (`uniqueRefs`, `:464`), and `sameCheckpointRefs` (`:58-61`) is a sort-then-compare multiset equality. A legitimately retried case therefore makes a healthy run's checkpoint read as broken.

**A retry is real, not hypothetical** — `run-workflow.ts:561-568`'s `occurrence` logic registers one `test-result` per occurrence, and `:1113-1115` deliberately keeps duplicate source occurrences ("each one is a real reproduction attempt"). Uniqueness is enforced per `attemptId` (`:664-667`), NOT per test-case artifact id.

- [ ] **Step 1: Write the failing tests**

For 1.2, a retest whose source scenarios include a case whose identity components rejoin to another selected case's — **note this is now unregisterable after Task 1**, so the test must exercise the collision at the function boundary rather than through registration. Assert the non-source case stays in the drive list.

For 1.3, a retest with two occurrences of one test case, asserting `validate` reports the run valid:

```ts
it("keeps a checkpoint valid when one selected case was driven twice", async () => {
  // a retest whose source bug names two attempts against the same case triple
  const result = await tester({ ...retestInput(root, bundle), retest: { sourceBug } });
  const inspected = await inspectWorkspaceState(root, result.runId);
  expect(inspected.diagnostics).toEqual([]);
});
```

- [ ] **Step 2: Run them and watch them fail.** Paste the real output, including the checkpoint-chain diagnostic for 1.3.

- [ ] **Step 3: Replace the join** with `indexTestCasesByIdentity`, following the `:1110-1111` idiom.

- [ ] **Step 4: Dedup `executionCaseRefs`** by `artifactId` before the comparison at `:525`. Do not change `sameCheckpointRefs` itself — it is also used by other clauses, and `sameOrderedCheckpointRefs` (`:65-68`) is a different comparator used at `:522` for the selection. Say in a comment what the dedup buys and why the left side is already unique.

- [ ] **Step 5: Run the covering tests, then the full gate.**

- [ ] **Step 6: Mutations**

| Mutation | Must redden |
|---|---|
| restore the `:`-join at `:1131` | the 1.2 test |
| drop the dedup | the retried-case test |

- [ ] **Step 7: Commit**

```bash
git add src/operations/run-workflow.ts src/core/inspect-workspace-state.ts tests/
git commit -m "fix: index the retest tail structurally, and stop a retry reading as corruption

Two items from one family. The retest branch of select-regression held the last
naive :-join in the identity family, where a collision silently drops a case
from the regression follow-up. And executionCaseRefs was built without dedup
against a duplicate-free left side, so a legitimately retried case -- which the
reproduction path deliberately produces -- made a healthy checkpoint read as
broken.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Exit-code honesty

**Files:**
- Modify: `src/core/run-workspace.ts:137-139`, and `src/core/fs.ts:137-142` if the wrap belongs there
- Modify: `src/regression/change-scope.ts:14,63,64`
- Modify: `src/operations/run-workflow.ts:1027,1103`
- Test: `tests/cli/*` for the exit codes, `tests/core/run-workspace.test.ts`

One theme: a user typo or a hand-edited input lands on exit 5 (`ABORTED_OR_INTERNAL`, "internal crash") where it should land on exit 3 (`INVALID_INPUT`, "bad input"). A CI script branching on exit code to tell those apart gets the wrong branch. `program.ts:355-358` is the fallthrough that produces 5 for anything not a `QaSkillsError`.

**Item 2.3 — one wrap, nine call sites.** `run-workspace.ts:138` calls bare `realpath(root)`; `fs.ts:139` calls bare `realpath(resolved)`. A missing root OR a missing run directory throws raw `ENOENT` before any `QaSkillsError` can fire. Reached by: `validate`, `approval record`, `attestation record`, `execute playwright`, `export`, three `artifact ingest` subcommands, and `workflow run --resume-run-id`.

Note `execute-observed-playwright.ts:343-346` documents the CURRENT behaviour as intentional. That comment must end up true or be corrected — do not leave it asserting the old behaviour.

**Item 2.1 — three bare `Error`s, not two.** `change-scope.ts:14`, `:63`, `:64`. `QaSkillsError` is NOT imported in that file, and the file has an unusual mid-file import block at `:22-24` after executable code at `:11-20` — pick a block deliberately. The file's own docblock at `:41-55` already narrates the exit-5 consequence.

**Item 2.2 — `retest: {}`.** `run-workflow.ts:1103` checks `!input.retest` then dereferences `input.retest.sourceBug`; `sourceBugFromReference` (`:683`) dereferences `reference.artifactId` at `:687`. **There is a sixth reach the five `!input.retest` guards miss**: `:1027` uses a truthiness check instead. Guard both.

- [ ] **Step 1: Write the failing tests** — assert the exit CODE, not only the message. The defect IS the code.

```ts
it("refuses an unknown run id as bad input, not an internal error", async () => {
  const run = await runCli(["validate", "--root", root, "--run-id", "no-such-run"], { cwd: root });
  expect(run.exitCode).toBe(ExitCode.INVALID_INPUT);
  expect(run.stderr).not.toMatch(/ENOENT/);
});
```

Plus: a hand-written `workflow run --input` whose `changeScope.changes` is empty (exit 3, not 5), and one whose `retest` is `{}` (exit 3, not 5).

- [ ] **Step 2: Run them and watch them fail.** Paste each, including the raw `ENOENT: no such file or directory, realpath '...'` in stderr — that string in a user-facing error is the defect.

- [ ] **Step 3: Wrap the realpath calls.** Translate `ENOENT` only. **Do NOT swallow other errno values** — a permission or I/O error must still surface as the internal error it is. Name the run id, not the resolved path.

- [ ] **Step 4: Convert the three `change-scope.ts` throws** to `QaSkillsError(..., "INVALID_ARTIFACT")`.

- [ ] **Step 5: Guard `retest.sourceBug`** at both `:1027` and `:1103`.

- [ ] **Step 6: Correct the `execute-observed-playwright.ts:343-346` comment** so it describes what the code now does.

- [ ] **Step 7: Run the covering tests, then the full gate.**

- [ ] **Step 8: Mutations** — for each of the three fixes, revert it and watch the matching exit-code assertion go red. Also: make the ENOENT catch unconditional and confirm nothing asserts a non-ENOENT error still reaches exit 5; if nothing does, add that test.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "fix: report bad input as bad input, not as an internal crash

Three sites where a typo or a hand-edited file landed on exit 5, the code
reserved for a crash, while every comparable refusal uses exit 3. A CI script
branching on the exit code to tell 'the user typed a bad run id' from 'the tool
broke' got the wrong branch.

The realpath wrap is one change covering nine commands. Only ENOENT is
translated: a permission or I/O error is still the internal error it is.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Gate honesty

**Files:**
- Modify: `src/reporting/release-gate.ts` (D9 drops, and the dead parameter at `:216,283,286,294`)
- Modify: `src/core/observed-coverage.ts` (one new question)
- Modify: `src/operations/run-workflow.ts:244,877-878`
- Test: `tests/reporting/release-gate.characterization.test.ts`, `tests/reporting/release-gate.test.ts`, `tests/core/observed-coverage.test.ts`

**Item 3.1 (D9) — there are more drops than the inventory said. Measured, all in `release-gate.ts`:**

- `resolveGateObligations` (`:153`, exported): `:192-193` unrecognised `executionSurface`; `:194-195` malformed `browser`/`viewport` (browser surface only); `:196-197` any of six required strings absent or `""`.
- `asAttempt` (`:228`, an arrow INSIDE `deriveReleaseGateFromWorkspaceArtifacts`, closing over `casesByIdentity`): `:229-231`, `:238-239`, `:240-241`, `:242-243`.
- The bug reducer's anonymous lambda at `:268`: `:270`.
- **A fourth silent drop that is NOT a `return []`**: `:262` `if (!bugId) continue;`.

**The markers are ten, not nine, and two expect a different verdict.** Nine in `tests/reporting/release-gate.characterization.test.ts` at lines 99, 115, 132, 144, 155, 166, 177, 190, 201, plus one at 522; **lines 190 and 201 assert `READY_WITH_RISKS`, not `READY`** — a blanket find-and-replace misses them. A **tenth, differently worded** marker is at `tests/reporting/release-gate.test.ts:86` ("Phase 3/D9 owns flipping it"), which a grep for the common string will not find.

Two traps: `browserDimensions` (`:47`) returns `undefined` only when `browser` is empty/non-string or the viewport lacks both numbers; and `:206` deliberately uses raw `typeof` for `accessibilityMethod` where `string()` is used elsewhere — an 8-line comment at `:198-205` explains why. Do not unify them.

**Item 3.4 — the dead parameter is safe to delete, and here is why.** `deriveReleaseGateFromWorkspaceArtifacts(artifacts, validationDiagnostics = [])` consumes it at `:283`, `:286`, `:294`. Both real callers pass one argument, so today `artifactsValid` is already `true` and `ruleInputs.validationDiagnostics` is already `[]`. **Deleting the parameter therefore produces byte-identical output, so no persisted gate can mismatch its re-derivation.** That is the check that makes this safe; state it in your report. Phase 8a's ruling stands: delete, never start passing.

**Items 3.2/3.3 — the hard part, and the plan is honest that it is hard.** Neither function has the selection in scope:

- `assertResultPostcondition(workspace, output)` (`:233`) — the adapter contract at `:195` fixes its signature, and `state` is in scope at all three call sites (`:851`, `:1041`, `:1070`) but is not passed.
- `finalizeWorkflowOutcome(workspace, mode)` (`:866`) — no `state`, no `input`; call sites `:1074` and `:1263`.

Two routes: widen the adapter type and thread the selection, or re-derive it from `artifacts` (already read) using the in-file `selectedCaseArtifactIds(selection, artifacts)` at `:783`. **Choose deliberately and justify in the code.** Re-deriving keeps the signatures alone but reads the workspace's selection artifact; threading is explicit but touches the adapter contract and three call sites.

**Key-space trap:** `observedCoveredCaseIds` returns artifact IDs (`ReadonlySet<string>`); `observedCaseIdentities`/`observedFailureIdentities` return structural `TestCaseIdentity`. Do not mix them.

**Module convention that binds the new function:** `observed-coverage.ts`'s docstring states that a new question must go through `observedCaseIdentities`'s `statuses` parameter, **not** a second loop — "A separate loop would be a third reader free to disagree about whether a batch counts." The single traversal with the credit gate is at `:128-135`.

- [ ] **Step 1: Write the failing tests**

For D9, invert the ten pinned expectations — those ARE the test. For 3.2/3.3, the discriminating fixture is **an unrelated batch in the workspace that the selection does not name**:

```ts
it("refuses an empty execution output when the batch covers nothing the selection named", async () => {
  // selection = {A}; workspace also holds a batch crediting only B, from an earlier unrelated run
  await expect(/* the resumed run */).rejects.toThrow(/must return registered test-result references/);
});
```

- [ ] **Step 2: Run them and watch them fail.** Paste each.

- [ ] **Step 3: Flip the D9 drops to fail-closed** — a malformed obligation counts as unmet rather than vanishing. Delete the ten stale markers; they promise a phase that shipped in July without doing this.

- [ ] **Step 4: Add the selection-scoped question** to `observed-coverage.ts`, through the existing traversal, and route both call sites through it.

- [ ] **Step 5: Delete the dead parameter** and its three consumers.

- [ ] **Step 6: Run the covering tests, then the full gate.**

- [ ] **Step 7: Mutations** — revert the D9 flip (the inverted pins must redden); widen the new question back to workspace-wide (the unrelated-batch test must redden); restore the dead parameter (nothing should redden — record that, because it is the evidence deletion was safe).

- [ ] **Step 8: Commit** in two commits: D9 + the dead parameter, then the selection-scoped reader. Messages must name the construction each closes.

---

### Task 5: Test gaps and export surfacing

**Files:**
- Test: `tests/observed/execute-observed-playwright.test.ts` (clean-filter fixture)
- Modify: `src/operations/export-projection.ts:24-32`, `src/reporting/projections/sarif.ts:121-129`, `src/cli/program.ts:305-311`
- Test: `tests/cli/export.test.ts`, `tests/operations/export-projection.test.ts`

**Item 5.1 — the clean-filter anchor test.** `execute-observed-playwright.ts:151-154` describes the bypass: `specTreeLine` hashes raw working-tree bytes while `git status` compares filter output, so a size-preserving `filter.<name>.clean` leaves the tree clean while the hashed bytes changed. Line `:159` claims both halves are pinned; only the symlink half is.

Copy the structure of the existing symlink test at `tests/observed/execute-observed-playwright.test.ts:429-462`, including the `spy(report, exitCode, duringRun)` third argument — `duringRun` runs inside the observed process's window, after the anchor resolves and before the producer sees an exit — and the explicit `60_000` timeout every case in that file carries.

**There is no shared git-fixture helper**; six suites each define their own local `git()` + `fixture()`. Copy this file's, at `:45` and `:129-140`. Its fixture already writes `[core] autocrlf = false`; your test appends a `[filter.<name>] clean = ...` section and a `.gitattributes`, **and `.gitattributes` must itself be committed or it dirties the tree that `resolveGitAnchor` refuses up front.**

**Item 5.2 — the drops-all-locations count.** `ExportProjectionResult` (`:24-32`) has no count of location-less results. `sarif.ts:121-129`'s `observedResult` has **two** early returns that both produce a result with no `locations` — `row.location === undefined`, and `artifactUri` returning `undefined` for a non-well-formed string — and its docstring says the two reasons are deliberately indistinguishable in output. Count both together; do not try to distinguish them.

**Trap:** `program.ts:306` does `JSON.stringify(result)` unfiltered, so **any field you add immediately becomes CLI stdout**, and `tests/cli/export.test.ts` may assert exact stdout.

**Item 2.5 (C8) — report before building.** A CLI-level test for `OBSERVED_RUN_SPEC_LOCATION_UNKNOWN` requires a real Playwright process to emit a report with no `config.rootDir`, and the JSON reporter always populates it. `program.ts:272` passes no `execute` seam and there is no flag for one. **Do not add a production seam just to make a test reachable.** Either cover the code→exit mapping directly as a unit table, or report that a true CLI-level test needs a production change and stop. Say which you did and why.

- [ ] **Step 1: Write the clean-filter test first**, and RUN it — it should pass only if the digest comparison genuinely catches the bypass. If it passes immediately, prove it discriminates by reverting the digest comparison and watching it redden.
- [ ] **Step 2: Write the failing export test** — a run whose every SARIF result lacks a location must report a non-zero count.
- [ ] **Step 3: Run both, paste the failures.**
- [ ] **Step 4: Thread the count** from the SARIF renderer's join through to the result, and print a stderr note when it is non-zero, in the shape of the existing `unreadableRunnerReports` note.
- [ ] **Step 5: Decide C8** and record the decision.
- [ ] **Step 6: Full gate.**
- [ ] **Step 7: Mutations** — remove the digest comparison (clean-filter test reddens); hardcode the count to 0 (export test reddens).
- [ ] **Step 8: Commit.**

---

### Task 6: Platform and provenance — last

**Files:**
- Modify: `.github/workflows/ci.yml:57`
- Modify: `src/installer/agents.ts:74-94`
- Modify: 28 `producerVersion` literals across 15 files
- Modify: `src/evidence/collector.ts:121,164`, `src/operations/run-workflow.ts:613`
- Modify: `tests/test-data/hooks.test.ts:32-43`

This group lands last so its CI result is read against an otherwise-finished branch.

**Item 6.2 — widen the Windows selection.** `ci.yml:57` runs `tests/core tests/contracts tests/cli tests/installer`. Add `tests/operations`, so the export hard-link/`nlink > 1` descriptor guard is finally exercised on NTFS instead of only APFS. **Per the spec's decision 4, findings are FILED, not fixed here.** The definition of done is "the selection is widened and CI has told us the truth" — green or red.

**Item 6.1 — `PATHEXT`.** `resolveCompatibleRuntime` (`:75`) probes exactly one filename: `"qa-skill.cmd"` on win32. A shim installed as `.exe` or `.bat` reports "not installed" though it would run. **Trap:** line `:76` uses the real `node:path`, not the injectable `execution.pathApi` that `resolveAgentRoot` uses, so it builds host-flavoured paths even when `execution.platform` says `win32` — a test must account for that. Also note `:82`'s regex means an existing-but-incompatible project binary aborts rather than falling through to PATH.

**Item 7.1 — 28 literals, not 24**, across 15 files, in three values (`0.1.0`, `0.2.0`, `1.0.0`), none matching the real `0.3.0`. The idiom to copy is the four existing dynamic sites: `import { runtimeVersion } from "…/installer/manifest.js"` then `producerVersion: runtimeVersion`. The source is `src/installer/manifest.ts:7`, itself a hand-maintained literal that nothing cross-checks against `package.json:3` — **note that in your report; do not fix it here.** Exclude the type declarations (`src/evidence/redaction.ts:3`, `src/contracts/types.ts:65`, `src/reporting/report-model.ts:6`, `src/reporting/projections/projection-model.ts:55,198`) — those are `producerVersion: string` members, not values.

**Item 7.2 — `browser: "playwright"`.** Three sites: `collector.ts:121,164`, `run-workflow.ts:613`. The field is `browser: string` with no enum, so it is not schema-blocked. Mirror `observedEngineOf` (`execute-browser-test.ts:102-108`). **The obstacle:** neither evidence site holds a `Browser` handle — `ActiveBrowserSession` carries only `context`, `page`, `telemetry`, `secrets`. Either walk `context.browser()` or thread the engine from `executeCanonical`, where it is already computed. **If threading turns out to reach further than this task should, stop and report** rather than restructuring the session type.

**Item 7.3** — one comment, `tests/test-data/hooks.test.ts:32-43`, attributing a rendering to `resolve()` when `relative()` inside `contained()` does it.

- [ ] **Step 1: PATHEXT test first**, then the fix.
- [ ] **Step 2: The `producerVersion` sweep.** Mechanical; verify the count reaches 28 and that no type declaration was touched.
- [ ] **Step 3: The `browser` field**, or a report saying why threading it is out of scope.
- [ ] **Step 4: The comment fix.**
- [ ] **Step 5: Widen the CI selection.** Last edit in the branch.
- [ ] **Step 6: Full gate locally.**
- [ ] **Step 7: Mutations** for the PATHEXT test and any behavioural change in step 3.
- [ ] **Step 8: Commit** in coherent pieces — the CI widening is its own commit, so a revert is one command if it turns out to need staging.

---

## Whole-branch close-out

- [ ] Run `superpowers:requesting-code-review` for a whole-branch review with **opus**, and point it at two questions: **did Task 1's bump miss a fixture that only fails on an untested path** (the sweep is the largest mechanical diff this project has taken), and **did Task 4's D9 flip change any verdict a real run can reach** (the whole point is that it should not, since registration already refuses malformed obligations — if the reviewer finds a reachable verdict change, that is a finding).
- [ ] Point the reviewer at the ledger's deferred-minor list so it can triage what must be fixed before merge.
- [ ] Verify the gate yourself at branch HEAD — all nine commands from a deleted `dist/` — rather than trusting an implementer's numbers. Three prior sessions caught a controller claiming verification it had not done, and one caught an implementer's own gate claim that was spurious because of command ordering.
- [ ] Record the outcome in `.superpowers/sdd/progress.md` under a `PHASE 9` heading, including what Task 6's Windows widening found.
- [ ] Close with `superpowers:finishing-a-development-branch`.

## Open questions carried into implementation

1. **The `pattern` value** (Task 1, Step 1) — minimum `^[^:]+$` unless measurement says otherwise.
2. **Threading vs re-deriving the selection** (Task 4) — both are defensible; the requirement is that the choice is deliberate and justified in the code.
3. **Whether a true CLI-level C8 test is worth a production seam** (Task 5) — the plan's answer is no; report if you disagree, do not build it.
4. **Whether `browser: "playwright"` can be fixed without restructuring `ActiveBrowserSession`** (Task 6) — if not, report rather than restructure.
5. **What the Windows widening finds** (Task 6) — filed, not fixed, on this branch.
