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

## Runtime acceptance evidence (2026-07-23)

- `tests/orchestration/runtime-public.e2e.test.ts` exercises the public `createQaTester` boundary using a real Playwright Chromium fixture and reopened `RunWorkspace` manifests, never a completion callback.
- The FULL tracer creates a terminal checksum-bound source plan bundle (analysis, safe-derived plan, canonical testcase, coverage obligation), imports it, executes live browser evidence, and verifies exact operation order, passed result, evidence, test-data manifest, coverage result, gate, and QA report.
- The no-runtime tracer proves rejection occurs before finalization and leaves a resumable workspace with neither a fabricated result nor QA report.
- Genuine REDs exposed two runtime defects: imported plans carried a self-asserted source approval, and full-mode coverage attempted to reopen its own live-locked workspace. Import now lets the target workspace derive approval, and coverage uses the active workspace.
- Callback orchestration is explicitly named `createUnsafeWorkflowRunnerForTests`; the public Skill Adapter requires a closed runtime registry.

Verification: focused runtime E2E passed repeatedly (final focused run: 2 tests); `npm test` passed 45 files / 268 tests; `npm run typecheck`, `npm run lint`, `npm run generate:types`, and `git diff --check` passed.

The public fixture-backed matrix now also covers regression and retest:

- REGRESSION imports the terminal source bundle into a fresh run, resolves checksum-bound runtime change scope, verifies selected-only Chromium execution and case-bound evidence, preserves unmapped risk as incomplete, generates the report, and proves source manifest bytes are unchanged.
- RETEST imports a terminal source product bug bundle, executes its exact testcase revision before regression selection, derives `FIXED` and independent `NOT_RUN` regression outcome from registered attempts, and preserves the source bug identity and source bytes. Multiple reproduction scenarios are not expressible through the current closed public retest input: it deliberately executes the one exact immutable source testcase once, so `PARTIALLY_FIXED`/`INTERMITTENT` remain covered by the verdict unit contract rather than fabricated at the public runtime boundary.
- A no-evidence runtime registry is rejected by the execution postcondition without a report; rechecksummed invalid charter budget, regression complete claim with unmapped risk, and retest verdict mutations all fail on workspace reopen.
- Package exports now expose only the production Skill Adapter and CLI; callback orchestration remains an explicit test-only source seam.

To stabilize genuine Chromium evidence work without relaxing assertions or timeouts, Vitest now runs test files serially; concurrent browser processes had caused an unrelated evidence-scrubbing integration test to exceed its default timeout on the second complete-suite run.

## Final hardening pass (2026-07-23)

- Browser execution now provides a runtime-owned `onBeforeSessionClose` hook after every action, assertion, and telemetry collection, while the active browser session is still available. Runtime evidence collection runs there, so screenshots observe the post-action outcome rather than a pre-action page.
- Runtime attempt IDs are ULID-based and unique across all phases. Regression execution derives runnable artifacts from `selected` decisions only; excluded decisions remain registered for audit but cannot execute.
- Screenshot protection is derived from the registered Environment Profile and host evidence policy. Production or protected profiles without a verifiable selector/region redaction plan register an Evidence Gap and never persist screenshot pixels.
- Canonical testcase revisions expose all mapping sources through `regressionIndex`; regression selections bind their exact change-scope record/checksum and a checksummed decision snapshot. Workspace reopening recomputes selection against the registered scope and mappings.
- Retest results now persist exact reproduction scenarios/statuses, regression attempt IDs, and a runtime-derived typed regression outcome. Unknown execution statuses reject; mixed distinct scenarios remain `PARTIALLY_FIXED`, while variation within one scenario is `INTERMITTENT`.
- Exploratory mode now creates a bounded runtime-owned browser context, performs one budget-bounded navigation, records live evidence and an `EXPLORATORY` finding linked to the registered charter, and derives its gate/report before profile completion. It remains non-authoritative for coverage.
- The published package root points at the actual compiled entrypoint and exports `createQaTester`, typed inputs/runtime registry, and canonical regression mapping APIs; the unsafe callback factory is absent from the package surface.
- Missing runtime services now return a durable `AWAITING_RUNTIME` result backed by a checksum-bound workflow checkpoint. A later public resume opens the same nonterminal run, verifies the immutable source bundle reference, and completes without re-importing canonical plan artifacts.

## Status

**BLOCKED.** The production runner now performs one `operationsForMode(mode)` iteration through a complete closed typed adapter map. Each adapter owns its labelled work and typed postcondition; immutable checkpoints are appended only after that postcondition succeeds. The public Chromium tracer proves the exact order, exactly one adapter/postcondition invocation per operation, and resume at the failed operation without rerunning earlier checkpoints. Regression decisions now bind exact testcase revision *and instance*, and retest source reproduction retains repeated scenario occurrences rather than deduplicating them.

Validation currently passes: generated types, typecheck, focused orchestration/retest/regression tests, the complete suite twice (46 files / 282 tests), lint, build, and `git diff --check`. A real public Chromium E2E now repeats one canonical source scenario twice against an alternating fixture, persists `INTERMITTENT`, and rederives it after reopen. This remains blocked for the required public Chromium acceptance E2E where one source bug has two distinct failed scenario instances and the target derives durable/reopened `PARTIALLY_FIXED`. The retest artifact now persists source testcase/attempt artifact IDs per occurrence, but workspace reopening still needs explicit source-artifact-ID tamper rejection beyond its existing scenario/attempt/instance/checksum validation.
