# Task 5 Evidence Capture Report

## RED

`npm test -- tests/evidence` initially failed as expected because the evidence modules did not exist. Additional RED checks were captured for the annotation contract, sensitive form-body scrubbing, immutable nested manifest data, and captured dimensions.

## GREEN

Implemented layered non-lowering evidence policy; capture-time selector and region masking; secret/header/body telemetry scrubbing; governed Evidence Gaps; strict CSS-to-pixel geometry; sanitized Sharp/SVG annotation; immutable checksummed manifests; active caller-owned session capture/attachment; and the annotation schema/catalog/generated declaration/CLI script.

## Verification

- `npm test -- tests/evidence` — 12 passing
- `npm test` — 189 passing
- `npm run typecheck` — passing
- `npm run lint` — passing
- `npm run check:generated` — passing
- `git diff --check` — passing

## Files

- `shared/schemas/annotation.schema.json`
- `src/evidence/{policy,redaction,geometry,annotator,collector,manifest}.ts`
- `src/operations/collect-evidence.ts`
- `scripts/annotate-screenshot.ts`
- `tests/evidence/*.test.ts`
- compatible catalog, validator, generated-type, and atomic binary-write updates

## Commit

`dc5f986 feat: capture auditable browser evidence`

## Concerns

Live evidence intentionally requires the Task 4 active-attempt registry. Once Task 4 closes that session, collector telemetry requests return an Evidence Gap and do not reconstruct observations.

## Review Fixes

Review fixes committed in `df8467c fix: register auditable evidence artifacts` move all public evidence capture, attachment, and annotation outputs into the authoritative `RunWorkspace` manifest. Binary media is atomically registered under `evidence/`; each media file is linked to a canonical descriptor, and unsafe capture paths register Evidence Gaps. Active Task 4 sessions retain resolved secrets only in memory for automatic capture/telemetry scrubbing.

Verification after review: focused evidence tests 14 passing; full suite 191 passing; typecheck, lint, generated drift, and diff checks passing.

## Second Hardening Wave

`c6e137b fix: make evidence registration transactional` adds a serialized workspace evidence-bundle transaction, exact binary descriptor metadata, deep binary-reference validation, and descriptor-derived annotation lineage. The obsolete free-form evidence manifest creator was removed; workspace registration is now the sole artifact model.

Verification: focused 101 tests and full 192 tests passing, plus typecheck, lint, generated-type drift, and diff checks.

## Final Bundle Validation

`da7723f fix: validate evidence bundles before persistence` makes annotation use `registerEvidenceBundle` exclusively. The bundle now plans binary IDs, checksums, descriptor references, and binding before any write, then rolls back all written media and descriptor files if the one manifest commit fails. Tests cover malformed descriptor pre-write rejection and manifest-write rollback.

Final verification: focused evidence/workspace suite 59 passing; full suite 194 passing; typecheck, lint, generated drift, and diff checks passing.

## Safety Completion

Strict RED-first safety tests exposed five workspace failures (late multi-binary rollback plus primary descriptor path/checksum/media bindings and rechecksummed persisted tampering) and one annotation failure (XML entity truncation in a hostile footer). The implementation now writes bundle binaries sequentially through the workspace persistence boundary, validates the descriptor's designated primary binary both before persistence and on every revalidation, and truncates raw text before XML escaping. Region masks no longer rely on a browser `crypto.randomUUID` implementation.

Added safety coverage verifies multi-binary rollback leaves no unregistered file or record; top-level primary path/checksum/media forgery rejects before persistence; rechecksummed persisted descriptor tampering rejects; colored DOM and region redaction changes only protected raw pixels; patterned annotation leaves raw bytes/checksum immutable; forged/foreign/checksum/media annotation sources reject; invalid geometry rejects; hostile SVG label/footer stays valid and inert; and descriptor or manifest failures roll back the annotated binary.

Verification:

- `npm test -- tests/core/run-workspace.test.ts tests/evidence/annotator.test.ts tests/evidence/collector.integration.test.ts` — 67 passing
- `npm test` — 210 passing
- `npm run typecheck` — passing
- `npm run lint` — passing
- `npm run check:generated` — passing
- `git diff --check` — passing
