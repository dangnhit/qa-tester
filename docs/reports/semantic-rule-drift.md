# Semantic-rule drift ledger — write path vs read path

**Task 6 (Phase 1 characterization).** Pins the CURRENT behavior of the two hand-written
semantic-rule chains in `src/core/run-workspace.ts` for the three overlapping planning
artifact types, before Phase 2 unifies them into one `Record<ArtifactType, SemanticRule>`.

This is a **characterization** map, not a fix list. Every disagreement below is documented,
not reconciled. Phase 2 will decide, per row, which behavior is canonical.

- **Companion spec:** `tests/core/semantic-rules.characterization.test.ts` (24 tests, all green;
  they pin the outcomes in this ledger and must stay green through Phase 2).
- **Behavior source:** exercised at runtime, not read off the source. Each outcome below was
  observed by driving the real public API.

## The two chains

| | Write path | Read path |
| --- | --- | --- |
| Function | `assertSemanticReferences` (`~1336`) → `assertTestPlanPolicy` / `assertCoverageObligationBinding` / `assertRequirementAuthorities` | `assertPersistedPlanningSemantics` (`~248`) |
| Reached via | `registerArtifactValue` / `registerArtifactValueBatch` (registration) | `RunWorkspace.validate` / `RunWorkspace.open` (workspace inspection) |
| On violation | **hard-throws** `QaSkillsError` (`code` `ARTIFACT_BINDING` or `UNSAFE_OPERATION`); registration is rejected | **soft diagnostic**: marks the artifact invalid and emits `{ code: "INVALID_REFERENCE", message }`; `validate` returns it, `open` re-wraps the first one as `ARTIFACT_BINDING` |

### Global mechanism asymmetry (applies to every reject row)

The two paths disagree on **mechanism and error code** in every rejecting case, independent of
the rule:

- Write throws and aborts the mutation with `ARTIFACT_BINDING`/`UNSAFE_OPERATION`.
- Read produces a non-throwing `INVALID_REFERENCE` diagnostic and lets the workspace load with
  the offending artifact flagged invalid.

Notably, an authority mismatch is coded `ARTIFACT_BINDING` on write but surfaces under
`INVALID_REFERENCE` on read even though the human-readable message is identical. The per-row
"disagreement" column below concerns the **accept/reject outcome and the message**; the
code/mechanism asymmetry is a constant and is not repeated per row.

## Pinned outcome matrix

Legend — Disagreement column: **AGREE** (same outcome and message, modulo the global mechanism
asymmetry) · **DRIFT-MESSAGE** (both reject, different reason) · **DRIFT-OUTCOME**
(accept-vs-reject) · **ASYMMETRY** (only one path checks this at all) · **UNREACHABLE**
(guarded before the rule runs on that path).

### `requirement-analysis`

| Case | Write outcome | Read outcome | Disagreement |
| --- | --- | --- | --- |
| Valid — authority equals provenance-derived value | ACCEPT | ACCEPT | AGREE |
| Authority disagrees with provenance (`ASSUMED` stated, `AUTHORITATIVE` derived) | THROW `ARTIFACT_BINDING` — `Requirement authority ASSUMED disagrees with provenance-derived AUTHORITATIVE` | INVALID_REFERENCE — `Requirement authority ASSUMED disagrees with provenance-derived AUTHORITATIVE` | AGREE (same message) |
| `statements` missing / empty | UNREACHABLE — JSON schema requires `statements` (minItems 1); registration fails contract validation first | UNREACHABLE — `inspectWorkspaceState` fails contract validation, never binds the value, never runs the rule | UNREACHABLE (both) |

### `coverage-obligation`

| Case | Write outcome | Read outcome | Disagreement |
| --- | --- | --- | --- |
| Valid — bound to exactly one matching requirement statement | ACCEPT | ACCEPT | AGREE |
| `requirementAnalysisArtifactId` references no analysis artifact | THROW `ARTIFACT_BINDING` — **`Coverage obligation references an orphan requirement analysis artifact`** | INVALID_REFERENCE — **`Coverage obligation references an orphan or ambiguous requirement`** | **DRIFT-MESSAGE** — write has a dedicated "orphan analysis artifact" branch; read folds this input into its combined message |
| `requirementId` absent from the analysis (orphan) | THROW `ARTIFACT_BINDING` — `Coverage obligation references an orphan or ambiguous requirement` | INVALID_REFERENCE — `Coverage obligation references an orphan or ambiguous requirement` | AGREE |
| `requirementId` matched by two statements (ambiguous) | THROW `ARTIFACT_BINDING` — `Coverage obligation references an orphan or ambiguous requirement` | INVALID_REFERENCE — `Coverage obligation references an orphan or ambiguous requirement` | AGREE |
| `requirementId` / `requirementAnalysisArtifactId` not a string | UNREACHABLE — schema requires non-empty strings; `INVALID_ARTIFACT` before the rule | UNREACHABLE — tamper to a non-string yields `ARTIFACT_TYPE_MISMATCH`; value never bound, rule never runs | UNREACHABLE (both) |

**Additional read-only cascade asymmetry (not separately tested):** the read path resolves the
source analysis with `candidate.valid && …` — if the referenced analysis is itself invalidated
earlier in the same inspection pass, the obligation collapses to the same
"orphan or ambiguous requirement" message. The write path has no equivalent "referenced
analysis was invalidated" notion (referenced analyses are always valid at registration time).

### `test-plan`

| Case | Write outcome | Read outcome | Disagreement |
| --- | --- | --- | --- |
| Valid — human-review plan | ACCEPT; workspace **derives** `approvalDecision = {approved:false, mode:"HUMAN_REVIEW", reasons:["policy-requires-human-review"]}` | ACCEPT (persisted `approvalDecision` equals derived) | AGREE |
| Caller supplies an `approvalDecision` on input (even a correct one) | THROW `ARTIFACT_BINDING` — `Test plan approval decision is derived by workspace registration and cannot be self-asserted` | ACCEPT — read **requires** a persisted `approvalDecision` equal to the derived one; "self-asserted" is not a concept on read | **DRIFT-OUTCOME + ASYMMETRY** — write forbids the field; read requires it |
| Persisted `approvalDecision` ≠ derived decision | UNREACHABLE — `withDerivedTestPlanApproval` strips/derives the field, so the write-path equality branch (`~1695`) can never observe a mismatch | INVALID_REFERENCE — `Persisted test plan approval decision does not equal the derived decision` | **ASYMMETRY** — checked only on read; write branch is dead code |
| `auto-approve-safe` policy whose derived decision is non-approved (e.g. open questions) | THROW `UNSAFE_OPERATION` — `Unsafe auto-approval: open-questions` | ACCEPT — read has **no** unsafe-auto-approval guard | **DRIFT-OUTCOME + ASYMMETRY** — write rejects unsafe auto-approval; read accepts the persisted result |
| Expected result references a requirement absent from every analysis (orphan/ambiguous) | THROW `ARTIFACT_BINDING` — `Test plan has an orphan or ambiguous expected result requirement` | INVALID_REFERENCE — `Test plan has an orphan or ambiguous expected result requirement` | AGREE (same message, via `deriveTestPlanApproval`) |
| Expected result's `authority` disagrees with its registered requirement's authority (`ASSUMED` on the expected result vs `AUTHORITATIVE` on the statement) | THROW `ARTIFACT_BINDING` — `Test plan expected authority does not match its registered requirement` | INVALID_REFERENCE — `Test plan expected authority does not match its registered requirement` | AGREE (same message, via `deriveTestPlanApproval:73`; independently triggerable — the schema does not tie `expectedResults[].authority` to the referenced requirement's authority) |
| Not exactly one authoritative environment profile | UNREACHABLE (as a failure) — the workspace always holds exactly one valid environment profile at registration; `assertArtifactBinding` forbids registering a second, and the profile is created with the workspace | INVALID_REFERENCE — `Test plan requires one authoritative environment profile` (reached when the profile is invalidated, e.g. checksum corruption) | **ASYMMETRY** — a reachable read failure with no reachable write counterpart |
| Registered requirement analyses re-checked for authority | Write re-runs `assertRequirementAuthorities` over ALL registered analyses (dead as a failure: each analysis already passed at its own registration) | Read's test-plan branch does **not** re-check requirement authorities (only `deriveTestPlanApproval`, which checks expected-result↔requirement authority equality) | **ASYMMETRY** — write re-validates authorities the read path does not |

## Reachability summary

**Reached and pinned on both paths:** requirement-analysis authority mismatch;
coverage-obligation orphan-analysis-artifact / orphan-requirement / ambiguous-requirement;
test-plan orphan expected result; test-plan expected-result authority mismatch; all three
valid/accept cases.

**Reached on one path only (accept-vs-reject or asymmetry, pinned):** test-plan
self-asserted decision (write reject / read accept); test-plan tampered decision (read only);
test-plan unsafe auto-approve (write reject / read accept); test-plan missing environment
profile (read only).

**Unreachable via the public API (pinned as guarded, no fabricated throw):**
requirement-analysis missing statements (both paths, schema); coverage-obligation
non-string binding (both paths, schema); test-plan persisted-decision-inequality on the WRITE
path (dead branch behind `withDerivedTestPlanApproval`); test-plan env-profile failure and
authority re-check on the WRITE path (structurally always satisfied at registration).

To reach any read-path branch for an input the write path rejects, the spec persists a valid
artifact and then tampers the bytes + recomputes the manifest checksum (the technique the
existing `run-workspace` / `workspace-coverage` tests use). This is called out in the spec's
comments and helper (`tamperRegistered` / `corruptWithoutRechecksum`).

## What Phase 2 must decide (not decided here)

1. **coverage-obligation orphan-analysis message:** keep the write path's distinct
   "orphan requirement analysis artifact" message or adopt the read path's combined one.
2. **test-plan `approvalDecision` stance:** write forbids the field on input while read requires
   it; a unified rule needs one coherent contract (derive-and-forbid-on-input vs
   require-and-verify).
3. **test-plan unsafe-auto-approval guard:** the read path does not enforce it — a plan the
   write path rejects with `UNSAFE_OPERATION` loads clean on read. Decide whether the unified
   rule re-verifies auto-approval safety at read time.
4. **Mechanism/error-code unification:** decide whether the unified table hard-throws or emits
   diagnostics per call site, and reconcile `ARTIFACT_BINDING` vs `INVALID_REFERENCE` for the
   same rule.
