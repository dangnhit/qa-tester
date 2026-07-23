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

## Verification

All commands exited successfully:

```text
npm test -- tests/core/run-workspace.test.ts tests/core/run-lock.test.ts tests/core/artifact-profiles.test.ts tests/cli/core.test.ts
npm test
npm run typecheck
npm run lint
git diff --check
```

Final full-suite result:

```text
Test Files  7 passed (7)
Tests       66 passed (66)
```

## Delivered

- Atomic, path-contained filesystem writes and SHA-256 checksums.
- Immutable run artifact registration, manifest validation, orphan/missing/checksum detection, and canonical JSON conversion for YAML Agent Drafts.
- Run lifecycle enforcement, exclusive live locks, stale-lock recovery, and explicit workspace close/reopen support.
- Mode-specific artifact profiles, including Evidence Gap as a structural evidence substitute.
- Commander CLI core: `init`, `artifact ingest`, `validate`, and `skills list`, with documented exit codes.
- Standalone run-creation and artifact-validation scripts plus operation wrappers.
- Focused tests covering workspace security/lifecycle/immutability, lock handling, profiles, and CLI initialization/skill listing/exit code map.

## Files changed

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
- `scripts/validate-artifacts.ts`
- `tests/core/run-workspace.test.ts`
- `tests/core/run-lock.test.ts`
- `tests/core/artifact-profiles.test.ts`
- `tests/cli/core.test.ts`

## Commit

`7497d06d340043f654eda8df80123d61a4127822` — `feat: add immutable QA run workspaces`

## Residual concerns

None identified for Task 2 review fixes.
