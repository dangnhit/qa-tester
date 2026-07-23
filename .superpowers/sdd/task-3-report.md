# Task 3 Report: Requirement, Testcase, Coverage, and Approval Operations

## Commit

- `545cb2e7a1d1d55777564ec9b508a22ccc6392ab` — `feat: add requirement and testcase planning`

## RED evidence

- `npm test -- tests/planning` failed as expected before implementation: all five planning suites could not resolve their missing planning modules.
- `npm test -- tests/planning/ingestion.test.ts` failed as expected before ingestion implementation: the missing ingestion operation import could not resolve.
- A later targeted ingestion test failed as expected when a production workspace was incorrectly evaluated as a test target; it resolved instead of rejecting. The implementation now derives approval classification from the registered environment profile.

## GREEN evidence

- `npm test -- tests/planning` — 6 files, 17 tests passed.
- `npm test` — 14 files, 128 tests passed.
- `npm run typecheck` — passed.
- `npm run lint` — passed without warnings.
- `npm run generate:types` — passed.
- `npm run check:generated` — passed after the generated declarations were committed.
- `git diff --check` — passed.

## Delivered files

- Contracts: `shared/schemas/requirement-analysis.schema.json`, `shared/schemas/coverage-obligation.schema.json`, `shared/schemas/test-plan.schema.json`, generated declarations, catalog, artifact type, and manifest updates.
- Planning: authority classification, canonical SHA-256 testcase revisions, parameter/browser expansion, authoritative coverage evaluation, and safe approval evaluation.
- Operations: provenance-preserving requirement/test-plan ingestion, requirement-reference validation, unsafe automatic approval rejection, and registered-environment enforcement.
- Tests: planning authority, revision, parameterization, coverage, approval, and ingestion suites.

## Concerns

- No remaining functional concerns. The final verification initially encountered a transient Vite `ENOSPC` while the filesystem had approximately 101 MiB free; storage recovered before verification and no workspace files were removed.

## Review-fix evidence

- Review-fix commit: `dbbb4297e4253e0ec2602a04a5996d74c36efac0` — `fix: harden requirement and testcase planning`.
- RED: `npm test -- tests/planning tests/cli/core.test.ts` produced 18 expected failures before the hardening work: direct/CLI authority bypasses, trusted DSL acceptance, and each obligation-dimension/provenance mismatch. `npm test -- tests/planning/ingestion.test.ts` then produced the expected persisted checksum-rewrite bypass failure.
- GREEN: planning, CLI, and workspace focused suites pass with 84 tests. The full suite passes with 146 tests; typecheck, lint, and `git diff --check` pass.
- Policy changes: generic and CLI ingestion route governed types through authoritative operations; workspace registration and persisted-artifact inspection both enforce provenance-derived requirement authority, exact/unique requirement references, registered-environment approval, and bounded actions. Specialized ingestion registers its already parsed validated value, eliminating the source reread gap.
- Additional safeguards: coverage requires exact obligation dimensions plus authoritative registered-requirement provenance; canonical fingerprints sort keys by Unicode code unit rather than locale-sensitive collation.

## Second review-fix evidence

- Commit: `e7e39f0c38ddb4e9958d667d8d7c6fe9e69921ba` — `fix: harden planning snapshots and coverage`.
- RED: queued `registerArtifactValue` mutation changed persisted bytes, and a human-review test plan with a self-declared authority mismatch was accepted. A missing governed coverage-ingestion operation also failed to load as expected.
- GREEN: registration snapshots values and relationships synchronously before its transaction boundary; all policies reject authority mismatches; coverage obligations bind to one registered requirement-analysis artifact and generic ingestion routes through the governed operation. Coverage evaluation requires verified authoritative requirements and verified immutable attempt IDs rather than caller authority/provenance fields.
- Final verification: 150 tests passed; typecheck, lint, generated-type check, and diff-check passed.

## Third review-fix evidence

- Commit: `f840a0575f55256529d249d502b53ab0a3a1c748` — `fix: revalidate persisted coverage obligations`.
- RED/GREEN: a checksum-rewritten coverage obligation that changed its requirement ID initially reopened successfully; it now fails deep workspace validation after its manifest checksum is rewritten. Full suite: 151 tests passed.
- Remaining: an authoritative manifest-derived `evaluateWorkspaceCoverage` operation that binds registered results to revisions/instances has not been implemented in this partial wave.

## Fourth review-fix evidence: workspace-derived coverage

- Planning commits: `545cb2e7a1d1d55777564ec9b508a22ccc6392ab`, `dbbb4297e4253e0ec2602a04a5996d74c36efac0`, `e7e39f0c38ddb4e9958d667d8d7c6fe9e69921ba`, `f840a0575f55256529d249d502b53ab0a3a1c748`, and `cafa4464026e6e1a8e39720055f5e1ae8d6b459b` — `feat: evaluate coverage from workspace artifacts`.
- RED: `npm test -- tests/planning/workspace-coverage.test.ts` failed because `evaluate-workspace-coverage` did not exist.
- GREEN: the new operation opens and freshly revalidates the registered workspace, resolves requirement authority from the linked immutable requirement-analysis artifact, binds a result to exactly one testcase revision and expanded instance, derives all coverage dimensions from that canonical case, and evaluates only passed attempts. Caller-provided IDs or verification context are ignored.
- Contracts and revalidation: testcase artifacts now require an immutable instance ID and coverage dimensions; results require that exact instance ID. Registration and persisted workspace validation reject orphan, ambiguous, revision-mismatched, or instance-mismatched results. Obligation and result checksum-rewrite tampering are rejected during reevaluation.
- Tests: positive authoritative flow; inferred requirement; spoofed caller context; orphan result; revision mismatch; requirement, role, behavior, browser, viewport, accessibility, risk, and outcome mismatches; obligation/result tampering. Full suite: 165 tests passed. Typecheck, lint, generated-type check, and diff-check passed.
