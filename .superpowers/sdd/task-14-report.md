# Task 14 report — SemanticRule abstraction + migrate the 3 planning types

## Status: DONE

## What was built

A shared `Record<ArtifactType, SemanticRule>` in the new `src/core/semantic-rules.ts`, consumed by
BOTH the write path (`assertSemanticReferences`) and the read path (`inspectWorkspaceState`) through
two thin adapters in `src/core/run-workspace.ts`. Only the three overlapping planning types
(`requirement-analysis`, `coverage-obligation`, `test-plan`) are migrated; every other type stays on
its legacy write branch / read inline-chain and the adapters fall through for them.

### `src/core/semantic-rules.ts` (new)
- Interfaces per design §1: `SemanticViolation`, `SemanticStage`, `RelatedArtifact`, `CrossRunView`,
  `SemanticContext`, `SemanticRule`, and `semanticRules: Partial<Record<ArtifactType, SemanticRule>>`.
- Three rule bodies (§5 verbatim, adapted only for `exactOptionalPropertyTypes` / narrowing).
- Imports **types + pure helpers only**: `assertRequirementAuthorities` (`../planning/authority.js`),
  `deriveTestPlanApproval` + `ApprovalDecision`/`ApprovalEnvironment` (`../planning/approval.js`),
  `isRecord` (`./values.js`), and the types `ArtifactType`, `ArtifactRecord`, `ArtifactProfileName`.
  **No `RunWorkspace`-class import** (grep confirms — only doc-comment mentions). Cross-run access is
  injected via `ctx.openRun`, so the module is cycle-free.

### `src/core/run-workspace.ts` (adapters)
- **Write adapter** `runSemanticRule(type, value, relationships, manifest)`: looks up the rule (returns
  `false` for un-migrated / non-write types before building any context, so no extra I/O for them),
  builds the write context, throws `QaSkillsError(v.message, v.code)` on a violation. Called at the TOP
  of `assertSemanticReferences` (`if (await this.runSemanticRule(...)) return;`), then the surviving
  legacy `if/else` chain (starting at `test-result`) handles the rest.
- **`buildWriteContext`**: pre-reads the related pool once per distinct registered non-media type via
  the zip helper; `registeredRecord` reads the manifest; `self` is a synthetic record; `openRun` wraps
  `RunWorkspace.open(this.root, …)`.
- **`readRegisteredRelated`** (zip-order helper, §8 risk 4): pairs
  `manifest.artifacts.filter(type && mediaType===undefined)` with `readRegisteredValues(manifest, type)`
  and asserts equal length before pairing by index.
- **Read adapter**: dispatches the rule inside `inspectWorkspaceState`'s fixpoint at the **exact slot**
  `assertPersistedPlanningSemantics` occupied, mapping a violation to
  `invalidate(artifact, diagnostics, "INVALID_REFERENCE", v.message)` and folding into `changed`.
  `buildReadContext` populates `relatedOfType` from the cascade-sensitive `validArtifacts` and
  `registeredRecord` from the full manifest; `openRun` wraps `RunWorkspace.open(dirname(dirname(path)), …)`.
- **Removed**: the `requirement-analysis`, `test-plan`, `coverage-obligation` branches from
  `assertSemanticReferences`; the private `assertCoverageObligationBinding`; the module-level
  `assertPersistedPlanningSemantics`.
- **Kept unchanged**: `withDerivedTestPlanApproval` + `assertTestPlanPolicy` as the write-only
  pre-registration transform (forbid self-asserted field, derive+inject decision, unsafe-auto-approval
  `UNSAFE_OPERATION`). Their call site (inside registration, before `assertArtifactBinding`) is untouched.

## Per-rule faithfulness

- **requirement-analysis** (both, sync): `assertRequirementAuthorities(ctx.value)`; on throw returns
  `{ ARTIFACT_BINDING, error.message }`. Legacy write wrapped the same throw as `ARTIFACT_BINDING`;
  legacy read called it directly and the fixpoint catch re-wrapped as `INVALID_REFERENCE` +
  `error.message`. Message/code preserved on both paths.
- **coverage-obligation** (both, sync): guard → `"Coverage obligation requirement binding is invalid"`
  (schema-guarded, unreachable — legacy had the identical dead guard); manifest existence via
  `ctx.registeredRecord` → `"…orphan requirement analysis artifact"` (**drift 1**); valid-pool
  statement count via `ctx.relatedOfType` → `"…orphan or ambiguous requirement"`. Two-pool split matches
  the legacy write (manifest `find` for message 2, `readRegisteredValues` for message 3); read now
  emits the specific message for a genuinely-missing record and preserves the combined message for the
  cascade case.
- **test-plan** (both, sync): one authoritative environment profile via `ctx.relatedOfType` →
  `"Test plan requires one authoritative environment profile"`; `deriveTestPlanApproval` (may throw the
  orphan/authority messages, surfaced with `error.message`); persisted-equals-derived JSON compare →
  `"Persisted test plan approval decision does not equal the derived decision"`. Stage-agnostic: on
  write the equality passes by construction because the retained transform already injected
  `approvalDecision`; the write-only forbid / unsafe-guard / authority-recheck stay in the transform
  (input-shape concerns handled before the rule, or provably-dead second-call branches).

## Two-pool (drift-1) handling
Message 2 keys on `ctx.registeredRecord` (manifest, stable on both paths); message 3 keys on
`ctx.relatedOfType` (valid pool, cascade-sensitive). A genuinely-missing record → message 2 on both
paths (the sanctioned change on read). A cascade-invalidated-but-registered record → message 2 skipped
(record in manifest) and message 3 fires (value gone from the valid pool) → combined message preserved.

## Drift-1 test edit + cascade lock test
`tests/core/semantic-rules.characterization.test.ts`:
- READ `it.each` retitled `"READ rejects when $label"`; each case given its own `message`; the
  missing-analysis-artifact case set to the WRITE message
  `"Coverage obligation references an orphan requirement analysis artifact"`, with a rationale comment
  pointing at `docs/reports/semantic-rule-drift.md` item 1. WRITE `it.each` unchanged.
- Added a targeted CASCADE-LOCK test: corrupt the analysis WITHOUT rechecksum (→ CHECKSUM_MISMATCH
  invalidation, record still registered) and assert the coverage-obligation still gets the COMBINED
  message — proving drift 1 did not leak into the cascade branch.

## TDD evidence
- After applying only the drift-1 test edit (implementation still unwired), the missing-artifact READ
  case failed RED: expected `"…orphan requirement analysis artifact"`, received the combined
  `"…orphan or ambiguous requirement"`. The cascade-lock and other 9 coverage-obligation rows stayed
  green on old code (lock, not drift).
- After wiring the adapters + removing the legacy branches: the drift-1 case is GREEN and all three
  characterization suites pass — `semantic-rules.characterization` (27), `inspect-workspace-state`
  characterization (2, unchanged), `release-gate` characterization (21).

## Full gate (all green, run before commit)
- `npm run typecheck` ✓
- `npm run lint` ✓ (deleted a stray gitignored `coverage/` dir that crashed typed linting, per brief)
- `npm run check:generated` ✓
- `npm test` ✓ — 413 passed / 60 files
- `npm run test:coverage` ✓ exit 0 — global stmts 91.11%, branch 80.93%, funcs 95.86%, lines 91.11%
  (thresholds 90/80/95/90). `semantic-rules.ts`: stmts 97.70%, branch 87.10%, funcs 100%; the only
  uncovered lines are the schema-guarded dead binding branch (the tests pin it unreachable).

## Grep — no RunWorkspace-class import
`grep -n "RunWorkspace" src/core/semantic-rules.ts` → only three doc-comment matches (lines 17, 40, 41,
78 mention it in prose); no `import` of the class. Imports are types + pure helpers only.

## Files changed
- `src/core/semantic-rules.ts` (new)
- `src/core/run-workspace.ts` (adapters wired; 3 legacy planning branches + `assertCoverageObligationBinding`
  + `assertPersistedPlanningSemantics` removed; transform kept)
- `tests/core/semantic-rules.characterization.test.ts` (drift-1 edit + cascade lock test)

## Self-review
- `semantic-rules.ts` has no `RunWorkspace`-class import (grep) and is cycle-free. ✓
- The 3 rule bodies reproduce the legacy checks/messages/codes; write throws `v.code`, read maps every
  violation to `INVALID_REFERENCE` + `v.message` (drift 4 mechanism preserved). ✓
- Only drift 1 changed observably; drifts 2–4 preserved (the two `DRIFT:` tests + the schema-guarded
  block are green and unchanged). ✓
- Read dispatch sits in the same fixpoint slot; `inspect-workspace-state` golden green unchanged;
  other ~21 types untouched (write branches + read inline chain intact). ✓
- `openRun` close-in-finally is the rule's responsibility (T15); the adapter returns a `RunWorkspace`
  that structurally satisfies `CrossRunView` (its `close()` releases the run lock). No T14 rule uses it.

## Concerns
None blocking. Two notes for later tasks: (1) the write adapter pre-reads all distinct non-media types
in the manifest when a migrated type registers — safe because every registered artifact is valid at
registration time (serialized `withManifestTransaction`); if that invariant ever weakened the extra
reads could surface a pre-existing corruption the legacy per-type path would not have read. (2) The
test-plan unsafe-auto-approval guard remains read-permissive by design (drift 3), flagged for Phase-3
hardening.
