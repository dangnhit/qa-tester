# Task 10 Report — End-to-End Demo, Documentation, Governance, and CI

## Implemented

- Added a deterministic localhost-only intentional-failure fixture and `npm run demo`.
- The demo starts on an ephemeral `127.0.0.1` port, executes real Chromium desktop and emulated mobile Test Case Instances, and makes no external request.
- The fixture omits its authoritative validation message, emits `QA_DEMO_CONSOLE_ERROR`, and calls a deliberately failed local endpoint.
- Runtime execution now preserves canonical per-instance viewports, derives `PRODUCT_DEFECT` for approved authoritative assertion failures, records opt-in Playwright traces, captures sanitized raw screenshots, derives annotated screenshots, and persists valid console/network telemetry.
- QA workflow finalization now distinguishes a schema-valid run containing non-passing attempts as `COMPLETED_WITH_FAILURES`.
- Added sanitized testcase/result/bug/QA-report examples.
- Added canonical English documentation and executable Vietnamese quickstart covering setup, config, CLI and exit codes, full/standalone skills, browsers, safety, evidence/redaction, artifact layout, troubleshooting, and Codex/Claude Code/Cursor installation.
- Added Apache-2.0 license, NOTICE, contribution and security policies.
- Added Ubuntu Node 22/24 quality CI, Windows Node 24 lifecycle CI, Chromium browser/demo CI, and a deterministic repository secret/ignore scan.

## TDD evidence

### RED

Command:

```text
npm test -- tests/e2e/demo.test.ts
```

Relevant failure before implementation:

```text
FAIL tests/e2e/demo.test.ts
Error: Cannot find module '../../scripts/run-demo.js'
Test Files 1 failed (1)
```

This was expected because the public demo harness and fixture did not exist.

### GREEN

Focused command:

```text
npm test -- tests/e2e/demo.test.ts
```

Result:

```text
✓ tests/e2e/demo.test.ts (1 test)
Test Files 1 passed (1)
Tests 1 passed (1)
```

The test independently verifies both instances are `FAILED + PRODUCT_DEFECT`, the run is `COMPLETED_WITH_FAILURES`, raw/annotated screenshots and traces exist, the report is `NOT_READY`, console/network failures are captured, and the Full Artifact Profile is valid.

## Complete verification

The brief’s exact sequence completed successfully:

```text
npm ci
npm run generate:types
npm run check:generated
npm run typecheck
npm run lint
npm test
npm run demo
npm run build
```

Results:

- Generated-type drift check: clean.
- TypeScript: clean.
- ESLint: clean.
- Full suite: 51 files, 301 tests passed.
- Demo: two intentional failures classified as product defects; raw and annotated PNGs plus trace ZIPs projected; `NOT_READY`; Full Artifact Profile valid; exit `0`.
- Build: clean.
- `npm run scan:secrets`: passed and confirmed `qa-results/` is ignored.

## Files changed

- Demo: `fixtures/demo/*`, `scripts/run-demo.ts`, `tests/e2e/demo.test.ts`
- Runtime support: `src/browser/types.ts`, `src/browser/playwright/executor.ts`, `src/evidence/collector.ts`, `src/operations/execute-browser-test.ts`, `src/operations/run-workflow.ts`
- Examples/docs/governance: `examples/*`, `README.md`, `docs/README.vi.md`, `LICENSE`, `NOTICE`, `CONTRIBUTING.md`, `SECURITY.md`
- CI/tooling: `.github/workflows/ci.yml`, `scripts/check-secrets.ts`, `package.json`, `.gitignore`

## Deviations

The task’s acceptance behavior exposed four missing runtime capabilities: canonical viewport propagation, authoritative assertion classification, trace/annotation registration, and failure-aware terminal status. Minimal supporting runtime changes were necessary so the demo could use the real public QA workflow instead of fabricating artifacts in the harness.

The run manifest retains canonical evidence paths under `evidence/`. The demo additionally creates ignored human-facing projections under `demo-artifacts/<run-id>/screenshots/{raw,annotated}` and `traces/`; consumers still resolve canonical artifacts through the Run Artifact Manifest.

## Self-review

- Confirmed the demo server binds only loopback and all fixture URLs are same-origin.
- Confirmed Test Case Instances use fresh contexts and distinct declared viewports.
- Confirmed examples contain synthetic identifiers and no secrets or real service data.
- Confirmed intentional test failures do not make `npm run demo` fail; missing detection or invalid artifacts do.
- Confirmed unrelated existing files and prior task changes were preserved.
- No unresolved concerns.
