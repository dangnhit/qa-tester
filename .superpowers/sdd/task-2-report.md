# Task 2 — Run Workspace, Lifecycle, Artifact Profiles, and CLI Core

## Status

READY_FOR_REVIEW

## TDD evidence

### RED

Initial focused command:

```text
npm test -- tests/core/run-workspace.test.ts tests/core/run-lock.test.ts tests/core/artifact-profiles.test.ts tests/cli/core.test.ts
```

Result: failed as expected with four import errors because Task 2 modules did not exist:

- `src/core/checksum.js`
- `src/core/run-lock.js`
- `src/core/artifact-profiles.js`
- `src/cli/exit-codes.js`

Follow-up RED after the first implementation pass:

```text
npm test -- tests/core/run-workspace.test.ts
```

Result: two intentional failures:

- `workspace.close is not a function` proved live-lock handoff had no close API.
- YAML Agent Draft registration failed with `Unexpected token 'a'` because it attempted JSON parsing.

### GREEN

The focused Task 2 suite passed after implementing the missing behavior:

```text
Test Files  4 passed (4)
Tests       14 passed (14)
```

### Review-fix RED/GREEN

The review-fix focused suite was first run against the inherited worktree and failed in the expected three places:

```text
Test Files  2 failed | 2 passed (4)
Tests       3 failed | 18 passed (21)
```

- A Commander unknown command was incorrectly returned as `ABORTED_OR_INTERNAL` (`5`) rather than invalid input (`3`).
- The symlink-destination regression fixture attempted to create a link over the already-created authoritative `inputs` directory.
- The old empty-manifest assertion no longer matched the registered, checksummed runtime environment profile.

After classifying `CommanderError` as invalid input and correcting the two review fixtures, the same command passed:

```text
Test Files  4 passed (4)
Tests       21 passed (21)
```

### Second review-fix wave RED/GREEN

Focused RED command:

```text
npm test -- tests/core/run-workspace.test.ts tests/core/run-lock.test.ts tests/core/artifact-profiles.test.ts tests/contracts/validator.test.ts tests/cli/core.test.ts
```

The initial run failed for the intended missing behavior:

```text
Test Files  5 failed (5)
Tests       15 failed | 57 passed (72)
```

The failures proved:

- Closed workspace objects could still mutate a run after lock handoff.
- Public lifecycle transitions could bypass finalization and profile validation.
- Concurrent stale-lock contenders leaked a raw `EEXIST` instead of establishing one atomic owner.
- Foreign run/environment bindings, unknown relationships, and a second environment profile were accepted.
- Evidence Gap had no canonical Draft 2020-12 contract and did not require `affectedClaim`.
- Artifact profiles had no audited version, arbitrary profile names failed accidentally, and finalization did not persist the selected profile/version.
- CLI path and symlink safety refusals returned invalid-input code `3` rather than safety-denied code `4`.

After the minimal fixes, the focused command passed:

```text
Test Files  5 passed (5)
Tests       72 passed (72)
```

### Third review-fix wave RED/GREEN

Focused RED command:

```text
npm test -- tests/core/run-workspace.test.ts tests/core/run-lock.test.ts tests/contracts/validator.test.ts
```

The initial run failed only on the newly specified behavior:

```text
Test Files  3 failed (3)
Tests       12 failed | 61 passed (73)
```

The RED failures demonstrated:

- A `full` run could downgrade finalization to `plan`.
- Persisted metadata, manifest, and authoritative environment bindings were not re-established on open/validate.
- `close()` left an interleaving window before marking the instance closed.
- A thrown finalization validation stranded metadata in `FINALIZING`.
- An abandoned stale-lock recovery mutex permanently blocked recovery.
- Active and terminal metadata did not conditionally forbid/require `finalizedProfile`.
- Governed payload references were not checked against registered test cases, attempts, steps, evidence, and run-owned test data.
- Lock release marked itself released before ownership verification completed, preventing retry.

After the fixes, the same focused command passed:

```text
Test Files  3 passed (3)
Tests       73 passed (73)
```

### Fourth review-fix wave RED/GREEN

Focused RED command:

```text
npm test -- tests/core/run-workspace.test.ts tests/core/run-lock.test.ts tests/contracts/validator.test.ts
```

The first run captured the intended fourth-wave gaps:

```text
Test Files  3 failed (3)
Tests       19 failed | 72 passed (91)
Errors      2 expected race-related unhandled rejections
```

The RED failures demonstrated:

- Concurrent registrations could overwrite one another's manifest updates and leave orphan files.
- `close()` released the run lock before an already-started registration settled.
- Finalization did not synchronously exclude late writers or drain registrations that had already entered the workspace.
- Metadata transition failures mutated in-memory state before durable persistence and could strand a run in `FINALIZING`.
- Only success/failure-derived terminal states were reachable; explicit `BLOCKED` and `ABORTED` outcomes were absent.
- Manifest records accepted ungoverned type labels, and persisted payloads were not revalidated against declared types, relationships, or semantic references.
- Terminal finalized profile names could disagree with the run mode.
- Test results did not bind to an exact test-case revision, and duplicate attempt definitions were accepted.
- Malformed or abandoned singleton recovery state could deadlock stale-lock takeover.

After implementing serialized manifest transactions, the synchronous finalization barrier, operation draining, copy-on-write transition persistence, deep persisted inspection, revision/attempt binding, and quarantine-based stale takeover, the same focused command passed:

```text
Test Files  3 passed (3)
Tests       91 passed (91)
```

### Fifth review-fix wave RED/GREEN

Focused RED commands:

```text
npm test -- tests/core/run-workspace.test.ts tests/contracts/generated-types.test.ts
npm run typecheck
```

The runtime RED run failed in the two intended places:

```text
Test Files  2 failed (2)
Tests       2 failed | 41 passed (43)
```

- A transient manifest write failure left the already-persisted canonical artifact as an `ORPHAN_FILE`.
- The generated run metadata declaration still exposed `[k: string]` and did not express its lifecycle/mode invariants.

The compile-time RED run reported four unused `@ts-expect-error` directives, proving that active metadata with `finalizedProfile`, terminal metadata without it, a mode/profile mismatch, and an excess property were all incorrectly assignable.

After adding transactional artifact rollback and a schema-derived governed run-metadata declaration, both commands passed:

```text
Test Files  2 passed (2)
Tests       43 passed (43)
Typecheck   passed with all negative type assertions consumed
```

## Verification

All commands exited successfully:

```text
npm test -- tests/core/run-workspace.test.ts tests/core/run-lock.test.ts tests/core/artifact-profiles.test.ts tests/cli/core.test.ts
npm test
npm run typecheck
npm run lint
npm run check:generated
git diff --check
```

Final full-suite result:

```text
Test Files  8 passed (8)
Tests       111 passed (111)
```

A separate stale-lock stress audit completed 100 iterations with 10 concurrent contenders per iteration and observed exactly one owner in every iteration.

## Delivered

- Atomic, path-contained filesystem writes and SHA-256 checksums.
- Immutable run artifact registration, manifest validation, orphan/missing/checksum detection, and canonical JSON conversion for YAML Agent Drafts.
- Run lifecycle enforcement, exclusive live locks, stale-lock recovery, and explicit workspace close/reopen support.
- Mode-specific artifact profiles, including Evidence Gap as a structural evidence substitute.
- Commander CLI core: `init`, `artifact ingest`, `validate`, and `skills list`, with documented exit codes.
- Standalone run-creation and artifact-validation scripts plus operation wrappers.
- Focused tests covering workspace security/lifecycle/immutability, lock handling, profiles, and CLI initialization/skill listing/exit code map.
- Closed-instance invalidation and finalize-only terminal lifecycle control.
- Atomic stale-lock recovery ownership with token-checked release.
- Workspace binding for run IDs, environment profile IDs, and manifest relationship IDs.
- Versioned Draft 2020-12 Evidence Gap schema with required reason and affected claim, including generated TypeScript declarations.
- Audited artifact-profile versioning persisted in run metadata at finalization.
- CLI safety-denied mapping for path traversal and symlink escape refusals.
- Exact mode-profile finalization with downgrade prevention.
- Persisted run/manifest/environment rebinding on every open and validation.
- Synchronous close invalidation and prevalidated, retryable finalization.
- Owner-identified stale recovery leases and retryable ownership-checked release.
- Conditional terminal-only `finalizedProfile` schema enforcement.
- Semantic payload reference validation for test cases, attempts, steps, evidence, and test-data ownership.
- Serialized manifest read/modify/write transactions with a stable finalization artifact set.
- Synchronous close/finalize admission barriers that drain already-started mutations before releasing or auditing.
- Copy-on-write metadata transitions with retryable `FINALIZING` and terminal persistence failures.
- Deep persisted artifact validation for declared type, checksum, relationship, run/environment binding, attempt identity, and exact test-case revision.
- Schema-enforced governed manifest types and terminal finalized-profile/mode coherence.
- Explicit, validated terminal paths for `COMPLETED`, `COMPLETED_WITH_FAILURES`, `BLOCKED`, and `ABORTED`.
- Unique quarantine-based stale-lock recovery that is independent of abandoned singleton recovery files.
- Canonical artifact rollback when manifest persistence fails, allowing an orphan-free retry inside the serialized transaction.
- Closed, schema-derived `QARunMetadata` lifecycle/mode typing with exact terminal profile names and forbidden active profiles.

## Files changed

- `.superpowers/sdd/task-2-report.md`
- `src/core/fs.ts`
- `src/core/checksum.ts`
- `src/core/run-workspace.ts`
- `src/core/run-lock.ts`
- `src/core/artifact-profiles.ts`
- `src/operations/create-run.ts`
- `src/operations/ingest-artifact.ts`
- `src/operations/validate-run.ts`
- `src/cli/exit-codes.ts`
- `src/cli/program.ts`
- `src/cli/index.ts`
- `scripts/create-run.ts`
- `scripts/generate-types.ts`
- `scripts/validate-artifacts.ts`
- `shared/schemas/artifact-manifest.schema.json`
- `shared/schemas/evidence-gap.schema.json`
- `shared/schemas/run-metadata.schema.json`
- `shared/schemas/test-result.schema.json`
- `src/contracts/catalog.ts`
- `src/contracts/generated/artifact-manifest.d.ts`
- `src/contracts/generated/evidence-gap.d.ts`
- `src/contracts/generated/run-metadata.d.ts`
- `src/contracts/generated/test-result.d.ts`
- `src/contracts/types.ts`
- `tests/core/run-workspace.test.ts`
- `tests/core/run-lock.test.ts`
- `tests/core/artifact-profiles.test.ts`
- `tests/cli/core.test.ts`
- `tests/contracts/generated-types.test.ts`
- `tests/contracts/run-metadata-types.test-d.ts`
- `tests/contracts/validator.test.ts`

## Commits

- `7497d06d340043f654eda8df80123d61a4127822` — `feat: add immutable QA run workspaces`
- `dc722e3` — `fix: address task 2 review findings`
- `08e9fe1` — `fix: close task 2 lifecycle safety gaps`
- `62d2be3` — `fix: enforce task 2 workspace invariants`
- `960d468` — `fix: harden task 2 finalization and validation`
- Final registration recovery and governed metadata typing wave — current commit

## Residual concerns

None identified for Task 2 review fixes.
