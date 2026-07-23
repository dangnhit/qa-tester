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
- `npm test` — 43 files, 262 tests passed
- `npm run typecheck`
- `npm run lint`
- `git diff --check`

`npm run check:generated` reports the intentionally changed generated manifest union until the generated files are staged; it passes after staging the generated contract output.
