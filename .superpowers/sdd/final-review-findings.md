# Broad Final Review Findings

Baseline: `623f074`
Reviewed HEAD: `d7e0b15`
Decision: `RESOLVED — READY_FOR_REVIEW`

## Critical

1. Public agent-draft ingestion accepts runtime-owned artifacts (`test-result`,
   `test-step-result`, `test-data-manifest`, `cleanup-run`, and related execution
   facts). Registration and coverage can therefore trust fabricated passes and
   cleanup facts. Restrict ingestion to draft-owned planning artifacts and make
   runtime results coherent, provenance-bound, step-derived, and unable to satisfy
   coverage/release without approved execution.
2. Protected telemetry persistence is authorized by a caller-controlled boolean
   named `deterministicTelemetryScrubber`, not an actual registered scrubber.
   Replace it with a concrete typed scrubber/registry identity and execution path,
   or emit Evidence Gaps. Arbitrary PII must not persist.

## Important

1. Add a real public `--version` contract and integration-test it through installer
   runtime resolution.
2. Add a clean bootstrap path for the first public workflow run. Users must be able
   to create a run/workspace and produce the initial planning bundle without an
   unexplained source run. Fix skill examples so `--root` is not doubled.
3. Make canonical planning-bundle import complete and transactional. Require the
   canonical planning set, enforce every postcondition including coverage
   obligations, and make resume continue/verify each exact artifact rather than
   treating one testcase as complete import. Strengthen terminal profiles.
4. Evidence Gaps must prevent a `READY` release recommendation and leave the
   relevant coverage/release condition unmet.
5. Add a reachable human-approval path and permit-scoped external-side-effect path.
   Persist a valid approval decision and pass a permit registry into execution;
   production remains explicit none-only and never auto-approved.
6. If video policy is `required`, capture supported video or emit an attempt-bound
   Evidence Gap and fail readiness/profile validation. Do not silently ignore it.
7. Redact browser-normalized secret variants, including percent-encoded values,
   before telemetry persistence.
8. Persist and validate annotated-screenshot source provenance: source artifact
   identity, source checksum/raw checksum, and derived-from relationship must remain
   auditable after reopening.
9. Make the package publishable and typed: remove `private: true`, generate and
   export `.d.ts`, expose `types`, and verify `npm pack` consumer installation.

## Minor

1. Add Windows-compatible portable-skill command examples alongside POSIX examples.
2. Exclude tests/fixtures/dev scripts from production compilation/package contents.

## Required Fix Protocol

- Use RED/GREEN tests for every finding.
- Preserve all prior task contracts and security invariants.
- Update relevant schemas, generated declarations, docs, skills, examples, CI, and
  `.superpowers/sdd` reports.
- Run the exact full acceptance sequence plus `npm pack`/clean-consumer smoke tests.
- Commit locally, leave the worktree clean, and do not configure a remote, push,
  create a PR, or deploy.

## Resolution

All findings above were resolved with focused RED/GREEN coverage. The final fix
report records the implementation mapping and the clean acceptance evidence.
