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

## Follow-up broad re-review

Reviewed HEAD: `024872e`

### Important

1. A crash after canonical planning-bundle commit but before checkpoint persistence
   leaves a complete import that resume rejects. Resume may adopt only one complete,
   exact source-ID/source-checksum provenance set and must reject partial, duplicate,
   or mismatched imports.
2. Skill Installation manifests do not bind the executable identity they verified.
   Record the command, real path, resolution source, compatible version, and binary
   checksum; verification must return typed missing, changed, and incompatible
   Runtime Binding failures.
3. Standalone agent-authored specialist skills have no public way to create an active
   Run Workspace and Requirement Analyzer uses an unexplained `RUN_ID`. Add a safe
   public nonterminal creation command and use its returned ID in both shell recipes.
4. Crash-recovery adoption treats canonical import provenance as an unordered set, so
   swapping complete provenance strings between target records is accepted. Bind each
   target one-to-one to its exact source type, artifact ID/checksum provenance,
   transformed canonical value/checksum, and rebuilt relationships/dependencies.
5. Checkpointed resume validates only the checkpoint’s imported artifact IDs, so an
   additional workspace artifact can reuse canonical import provenance without detection.
   Require the complete workspace provenance-import ID/mapping set to equal the checkpoint
   mapping exactly, rejecting extras, omissions, duplicates, provenance reuse, and
   mismatched targets.

### Minor

1. QA Tester’s PowerShell full-run recipe omits the planning bootstrap that its POSIX
   recipe performs.

All follow-up findings are resolved and the decision remains `READY_FOR_REVIEW`.

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
