# Phase 9 — clearing the carry-forward debt before v1.0

The production-readiness roadmap (`docs/superpowers/plans/2026-07-24-production-readiness.md`) ends at Phase 8,
and all three of its v1.0 exit criteria are met: an external Playwright suite runs under `runtime-observed` and
credits coverage, the gate models every execution surface honestly, and a CI pipeline fails on `NOT_READY` and
reads JUnit/SARIF. The package is still `0.3.0`.

This phase ships no features. It collects the items every phase from 3 onward filed and never returned to,
rules on each, and leaves a clean list for the v1.0 decision — which is deliberately NOT part of this phase.

Baseline: `main` @ `6bb1310`, CI green on all five jobs (run 30731607657). Gate at that head,
controller-verified from a deleted `dist/`: 1299/1299 tests (90 files), coverage 94.32/84.52/98.19/94.32
against the 90/80/95/90 floor, secret scan over 331 tracked files, `smoke:package` green.

## Where the list came from

A read-only inventory pass verified every candidate against the code at `6bb1310` rather than trusting the
ledger's prose, and classified each as still open, already fixed, or unverifiable. The result:
**16 still open, 16 already fixed but still carried in the ledger, 1 unverifiable** (NTFS `nlink` semantics,
which needs Windows hardware). The full inventory, with `file:line` for every item, lives at
`.superpowers/sdd/debt-inventory.md`.

The "already fixed" half matters as much as the open half: it is what stops this phase re-litigating settled
work. Sixteen items the ledger still describes as open were closed by later phases without the ledger being
updated — including two of the three colon-collision bugs.

**One inventory claim was overturned by the controller before this spec was written.** The inventory ranked D9
(item 3.1) as "the most safety-relevant item, a fail-open on a critical-path check". Measured: every field the
gate can drop an obligation on — `outcome` among them — is in `coverage-obligation.schema.json`'s `required`
list with `additionalProperties: false`, so a malformed obligation can never be *registered*. D9 is a fail-open
in an exported pure function whose real callers are schema-protected. It is worth fixing as defense in depth,
and its ten stale characterization comments are worth deleting, but it is not a live critical. Recorded here so
the implementer does not inherit an inflated severity.

## Decisions

Each was taken by the user during brainstorming; the reasoning is recorded so it is not relitigated.

1. **Take the breaking schema bumps now.** Adding a `pattern` to an identity field bumps a `const
   schemaVersion` and invalidates every existing run's artifacts of that type on `validate`. Pre-1.0 is the
   only moment that costs nothing but the bump itself; after 1.0 the same fix needs a migration story. The
   alternative — keep patching readers — is a losing game: the same colon-collision has now been fixed three
   times in three different modules while the data shape stayed permissive, and a fourth naive
   `${a}:${b}:${c}` is one commit away.
2. **D9 flips to fail-closed, and the promise it made is retired.** A malformed obligation counts as unmet
   rather than vanishing. Rejected: leaving the behaviour and only fixing the comments (defense in depth on the
   gate is worth more than the diff), and refusing the whole gate derivation (that turns a soft verdict into a
   hard failure on a path nobody can currently reach).
3. **One shared selection-scoped reader for items 3.2 and 3.3.** Both ask "does any observed case exist
   anywhere in this workspace" when they mean "is this run's selection covered". Rejected: fixing each call
   site locally — two places that must stay in step is precisely how these two drifted apart, and
   `observed-coverage.ts` exists to be the one reader of this fact.

   **⚠️ THIS DECISION WAS WRONG FOR 3.2 AND WAS REVERSED DURING THE WHOLE-BRANCH REVIEW.** It rests on a
   premise that does not hold: a batch cannot be "anywhere in this workspace" but not this run's, because
   `runId` is schema-required on `test-result-batch` and both `RunWorkspace`'s registration guard and
   `inspectWorkspaceState` refuse a mismatch. Unscoped already meant "this run's batches". Scoping the
   FAILURE question therefore removed a real signal rather than a false one, and reopened what Phase 8b
   closed — a `regression` run whose own observed suite reported `PRODUCT_DEFECT` on an unselected case
   finalized `COMPLETED` and exited 0 with nothing an operator reads saying a test failed. **3.3 keeps the
   scope; 3.2 is unscoped.** The two questions are not one question: excusing an empty drive list is a claim
   about what a run REQUESTED, reporting a failure is a claim about what its suite OBSERVED.
4. **Widen the Windows CI selection, and treat what it finds as a separate branch.** Rejected: absorbing the
   findings here (the last time this project widened that selection it surfaced 74 failing tests and 4 real
   user-facing defects, so the phase's size would become unknowable), and leaving it alone (a security guard
   stays unverified on the platform where its primitive behaves most differently).
5. **`export`'s `LIVE_LOCK` behaviour stays as it is** (item 2.4). A live run legitimately has no release gate,
   and exiting 2 rather than 3 is defensible; `recovery.md` already documents it. The Phase 8a design doc's
   enumeration is the thing that was incomplete. **This is a ruling, not work** — recorded so it is not re-filed.
6. **No v1.0 bump, no release notes, no tag.** That decision is taken after this phase, with a clean list.

## What ships

**Every open item except 2.4**, grouped so each group is one reviewable unit.

A note on counting, because the two numbers in this document disagree and a reader will notice: the inventory
summarises "16 still open" but its numbered list runs 1.1 through 7.3, because several entries span more than
one theme and it counted themes, not entries. This spec works from the numbered entries, which is the list an
implementer can actually tick off. Nineteen of them ship here; 2.4 is ruled no-change. If an entry below has no
group, that is a gap in this spec, not a deliberate omission — say so rather than skipping it.

### Group 1 — the schema bumps, alone

| Schema | Version | Change |
|---|---|---|
| `test-case` | 2.0.0 → 3.0.0 | `pattern` forbidding `:` on `testCaseId`, `revisionId`, `instanceId` |
| `test-result` | 2.0.0 → 3.0.0 | same, on `testCaseId`, `testCaseRevisionId`, `testCaseInstanceId` |
| `test-result-batch` | 3.0.0 → 4.0.0 | same, on the entry's three identity fields |
| `coverage-obligation` | 3.0.0 → 4.0.0 | `pattern` on `obligationId` |
| `evidence-gap` | 1.0.0 → 2.0.0 | `pattern` on `evidenceGapId` |
| `human-attestation` | 1.0.0 → 2.0.0 | `pattern` on `obligationId` (the field it joins against) |

Measured cost, not estimated: roughly 100 `schemaVersion` literals across `tests/` and `src/` must move
(55 sites carry `"2.0.0"`, 63 carry `"3.0.0"`, 181 carry `"1.0.0"`, and the relevant subset of each must
change). The edit is mechanical and self-verifying — a missed literal fails loudly at validation — but it is
large, which is exactly why **this group contains nothing else**. A reviewer reading a hundred-line mechanical
diff must not simultaneously be judging logic.

This group must land first: every later group's fixtures are written against the new versions.

**Open question for the implementer, to be answered by measurement, not assumption:** what the `pattern` should
be. Forbidding only `:` (`^[^:]+$`) is the minimum that closes the collision class. A stricter pattern risks
refusing identities real users already have. Report which you chose and why.

**Scope of the claim, so it is not quoted more widely than it holds** (added after the whole-branch review; the
bumps shipped as specified). These six bumps make the colon collision unrepresentable in **exactly the fields
the table above names, and no others**. It is NOT a uniform property of the artifact set:
`evidence-gap`'s own `testCaseId`/`testCaseRevisionId`/`testCaseInstanceId`
triple, `evidence.subject`'s triple, `regression-selection.$defs.decision` and `test-plan`'s `browserExecution`
all still carry identity components with no `pattern`. So "closed at the data shape" is true of the joins that
exist, not of the shape as a whole — and the reader-side structural indexing stays the defense, not a
redundancy. A v1.0 decision that wants the uniform property has to bump those four as well.

### Group 2 — identity

- **1.2** — `run-workflow.ts`'s `retest` branch still builds a `Set` of `:`-joined `sourceIds`, the last naive
  join in the identity family, while the rest of that same file uses `indexByTestCaseIdentity`. A collision here
  silently drops a case from a retest's regression follow-up — an execution that never happens, not a false credit.
- **1.3** — `inspect-workspace-state.ts` builds `executionCaseRefs` with no dedup while `state.executionCases` is
  duplicate-free, and the two are compared as multisets. A legitimately **retried** case therefore makes a healthy
  run's checkpoint read as broken. This is a live false-positive on `qa-skill validate`, not a hypothetical.

### Group 3 — exit-code honesty

One theme: a user typo or a hand-edited input gets exit 5, "internal crash", where it should get exit 3, "bad
input". A CI script branching on exit code to tell those apart gets the wrong branch.

- **2.3** — `RunWorkspace.open`'s unguarded `realpath`: an unknown run id throws a raw `ENOENT`. One wrap fixes
  `validate`, `export`, both human-record commands, `execute playwright`, three `artifact ingest` subcommands,
  and `workflow run --resume-run-id` at once. Best ratio in the whole inventory.
- **2.1** — `registerChangeScope`'s producer guard throws a bare `Error`, so the same malformed change scope
  that scaffold refuses cleanly exits 5 when it arrives through a hand-edited `workflow run --input`.
- **2.2** — `retest: {}` with `sourceBug` absent dereferences `undefined` deep inside `reproduce-bug`.

### Group 4 — gate honesty

- **3.1 (D9)** — flip the fail-open drops to fail-closed: a malformed obligation counts as unmet. Ten
  characterization comments currently promise "Phase 3/D9 will change this to NOT_READY" — a Phase 3 that
  shipped in July without doing it. Invert the pinned expectations and delete the promise.
- **3.2 + 3.3** — add one selection-scoped question to `observed-coverage.ts` and route both call sites through
  it. 3.3 is the sharper of the two: an unrelated leftover batch anywhere in the workspace currently lets an
  execution operation return zero results without throwing, so a run can finalize having driven and observed
  nothing relevant to its own selection. 3.2 only over-reports failure and provably cannot mask one.
  **As shipped: 3.3 only.** See the reversal recorded under Decision 3 — there is no such thing as an
  unrelated leftover batch, and scoping 3.2 masked a failure rather than stopping an over-report.
- **3.4** — delete `deriveReleaseGateFromWorkspaceArtifacts`'s dead second parameter. Both real callers pass one
  argument, so the `VALID_ARTIFACTS` rule can never fail on any live path. Phase 8a already recorded the ruling:
  *delete the parameter, never start passing it* — because if a future change made only one caller pass a
  non-empty array, every already-persisted gate would permanently mismatch its own re-derivation, and a gate
  artifact is immutable.

### Group 5 — test gaps and export surfacing

- **5.1** — the spec-tree digest is the last defense against a working tree `git status` calls clean but isn't.
  Only the symlink half is pinned; a size-preserving `filter.<name>.clean` has no test, so a future
  simplification of the digest comparison could reopen the bypass silently. Needs a `.gitattributes` plus a
  local git config fixture.
- **5.2** — if the SARIF join fails for every finding, the operator gets exit 0 and a valid-but-location-less
  file with nothing flagging it. Add a count of location-less results to the export result and print a note.
- **2.5 (C8)** — `OBSERVED_RUN_SPEC_LOCATION_UNKNOWN` has no CLI-level test, because the real Playwright process
  always emits `config.rootDir`. Cover the code→exit mapping at the boundary that matters.

### Group 6 — platform and provenance, last

- **6.2** — add `tests/operations` to the Windows CI selection, so the export hard-link/`nlink > 1` descriptor
  guard is finally exercised on NTFS instead of only APFS. **Findings are filed, not fixed here** (decision 4).
- **6.1** — `resolveCompatibleRuntime` probes one hardcoded filename and ignores `PATHEXT`, so a Windows shim
  installed as `.exe` or `.bat` reports "not installed" though it would run.
- **7.1** — 24 hardcoded `producerVersion` literals (`"0.1.0"`/`"0.2.0"`) while the package is `0.3.0`, so
  artifacts misreport which build produced them. Four sites already read the real runtime version; make the
  rest match.
- **7.2** — evidence `provenance.browser` is hardcoded `"playwright"` (the driver) while fixtures say
  `"chromium"` (the engine). Never read for any crediting decision — this is an audit-trail honesty fix. Source
  it the way `observedEngine` already does.
- **7.3** — `tests/test-data/hooks.test.ts`'s comment attributes a rendering to `resolve()` when `relative()`
  inside `contained()` does it. One comment.

This group lands last so its CI result is read against an otherwise-finished branch.

## Error handling

No new exit code, no new error code. Every refusal this phase adds reuses `INVALID_ARTIFACT` (exit 3) or
`ARTIFACT_BINDING`, matching every prior phase. The exit-code group's whole purpose is to move failures that
currently land on `ABORTED_OR_INTERNAL` (5) onto the code that describes them.

## Testing

TDD, test first and watched failing; every test proven by mutation; no snapshots; ESM `.js` imports; no new
runtime dependency. The nine-command gate from a deleted `dist/`, floor 90/80/95/90.

Group-specific obligations:

- **Group 1** — a rejection test per patterned field: an id containing `:` must be refused at registration. That
  test is the whole point of the bump, and it is what makes the reader-side fixes redundant rather than load-bearing.
- **Group 2** — 1.3 needs a test with a genuinely **retried** case proving the checkpoint stays valid; that is
  the live false positive.
- **Group 3** — assert the exit CODE, not only the message. The defect is the code.
- **Group 4** — D9's ten inverted pins are the test. For 3.2/3.3, the discriminating fixture is an unrelated
  batch in the workspace that the selection does not name.
- **Group 6** — 6.2's definition of done is "the selection is widened and CI has told us the truth", green or red.

**Stage with `git add` before `npm run scan:secrets`.** The scanner walks `git ls-files`, and this project has
twice recorded a passing scan that was spurious because the file was untracked.

## Out of scope

- The v1.0 version bump, release notes, and tag.
- Item 2.4 — ruled no-change above.
- Whatever Group 6's Windows widening finds: filed, fixed on its own branch.
- The roadmap's own permanent exclusions: auth, flake management, sharding, a broader browser DSL (all
  delegated to lane 2's runner per ADR-0010); visual regression, native mobile, real-device (modelled as
  authorable-but-unmet obligations); Jira/TestRail sync (deferred post-v1.0).
- Any new feature. If this phase ships a capability, it has failed.
