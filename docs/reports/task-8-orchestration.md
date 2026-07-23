# Task 8: Orchestration Modes, Retest, Regression, and Exploratory Testing

## TDD record

Focused RED was captured with the Task 8 public seams absent:

```text
npm test -- tests/orchestration tests/exploratory tests/retest tests/regression
Failed suites: orchestration/modes, exploratory/charter, retest/verdict, regression/selector
Cause: missing Task 8 modules
```

The green slices cover mode ordering, bounded exploration charters and non-authoritative findings, independent retest verdicts, and deterministic regression selection.

## Delivered behavior

- The QA Tester is a thin adapter over `runWorkflow`; workflow ordering comes from typed operation metadata and never shells one skill into another.
- Public modes are limited to `plan`, `execute`, `full`, `exploratory`, `retest`, and `regression`; cleanup remains maintenance-only.
- Execution requires a registered approved canonical testcase revision. Full mode reaches execution only through the existing derived safe-approval path.
- Retests require a linked source run, replay the source bug's exact testcase revision before regression work, preserve the source bug ID, and calculate the retest verdict independently of a regression outcome.
- Exploration requires a mission, scope, roles, heuristics, safety rules, action/time budgets, and stop conditions. Findings are explicitly non-coverage observations.
- Regression selection uses requirement, code-surface, declared-dependency, git-diff, then user-scope priority. Every decision has rationale and confidence; unmapped risks force `complete: false` and block a complete release claim.
- Exploration charters, retest results, and regression selections are schema-validated canonical artifacts and are registered through the run workspace.

## Verification

- `npm run generate:types`
- `npm test -- tests/orchestration tests/exploratory tests/retest tests/regression`
- `npm test` — 44 files, 266 tests passed
- `npm run typecheck`
- `npm run lint`
- `git diff --check`

`npm run check:generated` reports the intentionally changed generated manifest union until the generated files are staged; it passes after staging the generated contract output.

## Review hardening

- Workspace reopening now revalidates charter environment binding, regression decision-to-case relationships and complete-claim risk semantics, and retest linked-source/reproduction/verdict relationships.
- Public `runWorkflow` does not accept caller callbacks. The callback factory is an explicit test seam; the public path uses its closed runtime registry.
- Dependency resolution performs a deterministic transitive topological closure and rejects cycles.
- Canonical change scopes carry a deterministic checksum and declared provenance before they can be used by regression selection.
- Retest verdicts distinguish partial repair across distinct affected scenarios from intermittent repeat outcomes within one scenario.

## Runtime integration follow-up

- `createQaTester(runtimeRegistry)` is the production public seam. Its input contains only runtime service IDs and checksum-bound source artifact references; it accepts no browsers, callbacks, resolver functions, raw change mappings, attempt IDs, or outcome claims.
- Canonical plan bundles are imported only from a terminal source run after every named record ID and checksum is reopened. Requirement analyses, plans, testcase revisions, and coverage obligations are copied in dependency order with local relationship remapping and rederived plan approval.
- Browser execution resolves a closed browser/secret/evidence registry at construction time. Evidence capture and telemetry attachment run while the runtime-owned browser session remains active, then the runtime checks that one result and case-bound evidence or gap were registered.
- Full runs require a configured browser manager, test-data registry, and canonical bundle. Missing runtime configuration fails before finalization, leaving a nonterminal workspace for an explicit resume rather than fabricating a report.
- Regression change scopes are registered from a closed source registry and their checksum is recomputed on every workspace reopen. Retest source bugs are checksum-bound and revalidated against the linked immutable source run before an independently derived verdict is persisted.
