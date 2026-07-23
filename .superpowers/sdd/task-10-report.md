# Task 10 Report — End-to-End Demo, Documentation, Governance, and CI

## Implemented

- Added a deterministic localhost-only intentional-failure fixture and `npm run demo`.
- The demo starts on an ephemeral `127.0.0.1` port, executes real Chromium desktop and emulated mobile Test Case Instances, and makes no external request.
- The fixture leaves its authoritative validation element empty, emits `QA_DEMO_CONSOLE_ERROR`, and calls a deliberately failed local endpoint.
- Runtime execution preserves canonical per-instance viewports, classifies `PRODUCT_DEFECT` only when the failed assertion explicitly binds an approved authoritative expected-result ID, obeys the resolved trace policy, records sanitized raw screenshots, derives attempt-bound annotated screenshots from the actual failed locator geometry, and persists permitted console/network telemetry.
- QA workflow finalization uses one validation-aware outcome helper, so the returned outcome and finalized metadata both become `COMPLETED_WITH_FAILURES` for execution failures or an invalid artifact profile.
- Added sanitized testcase/result/bug/QA-report examples.
- Added canonical English documentation and executable Vietnamese quickstart covering setup, config, CLI and exit codes, full/standalone skills, browsers, safety, evidence/redaction, artifact layout, troubleshooting, and Codex/Claude Code/Cursor installation.
- Added Apache-2.0 license, NOTICE, contribution and security policies.
- Added Ubuntu Node 22/24 full-suite/build CI, Windows Node 24 lifecycle/build CI, Chromium browser/demo CI, immutable action SHAs, and a deterministic repository/package-lock secret/ignore scan.

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

## Review fix wave

The requested hardening changes were implemented with a second RED/GREEN cycle.

RED command:

```text
npm test -- tests/e2e/demo.test.ts tests/e2e/demo-resources.test.ts tests/browser/executor.integration.test.ts tests/orchestration/modes.test.ts tests/cli/installed-cli.test.ts
```

Initial result: 5 test files failed, with 7 failing and 17 passing tests. The failures covered protected trace persistence, provisional annotations, authority binding, validation-aware outcomes, nested cleanup, and installed CLI packaging.

GREEN evidence:

- Focused hardening set: 6 files, 85 tests passed.
- Demo standard and protected-secret modes: 2 tests passed.
- Full suite: 53 files, 307 tests passed.
- Protected-secret test scans every persisted file and confirms that neither trace bytes nor the resolved secret are stored; each attempt receives a trace Evidence Gap.
- Standard demo acceptance checks raw screenshot, real annotated screenshot, trace, console, and network evidence separately for desktop and mobile, plus the owned-resource Cleanup Run.

## Second re-review fix wave

The remaining screenshot-safety, classification, and CLI-documentation findings were closed with a third RED/GREEN cycle.

RED command:

```text
npm test -- tests/e2e/demo.test.ts tests/browser/executor.integration.test.ts tests/cli/core.test.ts
```

Initial result: 3 test files failed, with 4 failing and 15 passing tests. The failures proved that protected and non-protected secret-resolved sessions still produced screenshot files, unbound failures were classified as `TEST_DEFECT`, and README still claimed every command emitted JSON.

GREEN evidence:

- Focused set: 3 files, 19 tests passed.
- Any session that resolves a secret now registers attempt-bound screenshot and trace Evidence Gaps when deterministic byte-level redaction cannot be proven; no PNG or trace archive is created. The screenshot rule is enforced directly at the collector boundary as well as by the workflow.
- The non-protected fixture fills a visible input with a resolved secret and scans every persisted file to prove the secret is absent.
- Protected demo telemetry persists only when the host registers its deterministic telemetry scrubber; the resolved secret is scrubbed before registration.
- Only failed assertions bound to approved authoritative expected results become `PRODUCT_DEFECT`; all other nonpassing attempts default to `UNDETERMINED` without an evidence-backed diagnosis.
- README explicitly documents that successful `qa-skill init` and `qa-skill artifact ingest` are silent on stdout, with CLI tests enforcing the behavior.

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
- Full suite: 53 files, 310 tests passed.
- Demo: two intentional failures classified as product defects; per-instance raw/annotated PNG, trace ZIP, and console/network evidence verified for the no-secret canonical path; owned resource cleaned in a linked run; `NOT_READY`; Full Artifact Profile valid; exit `0`.
- Build: clean.
- `npm run scan:secrets`: passed across tracked text files including `package-lock.json`, and confirmed `qa-results/` is ignored.

## Files changed

- Demo: `fixtures/demo/*`, `scripts/run-demo.ts`, `tests/e2e/demo.test.ts`, `tests/e2e/demo-resources.test.ts`
- Runtime support: browser assertion authority binding and conservative fallback classification, final attempt-bound evidence/annotation validation, secret-aware screenshot/trace Evidence Gaps, explicitly registered protected-telemetry scrubbing, validation-aware finalization, and trusted Test Data Hook selection/cleanup lifecycle.
- Examples/docs/governance: `examples/*`, `README.md`, `docs/README.vi.md`, `LICENSE`, `NOTICE`, `CONTRIBUTING.md`, `SECURITY.md`
- CI/tooling: `.github/workflows/ci.yml`, `scripts/check-secrets.ts`, `package.json`, `package-lock.json`, installed CLI smoke coverage, and the Unix CLI shebang.

## Deviations

The task’s acceptance behavior and review exposed supporting runtime needs beyond the initial harness: canonical viewport propagation, typed authoritative expected-result binding, conservative undiagnosed-failure classification, policy-driven trace retention, final attempt-bound annotations, secret-aware screenshot/trace Evidence Gaps, registered protected-telemetry scrubbing, validation-aware terminal status, and public trusted hook selection. These minimal runtime changes keep the demo on the real public QA workflow instead of fabricating artifacts.

The run manifest retains canonical evidence paths under `evidence/`. The demo additionally creates ignored human-facing projections under `demo-artifacts/<run-id>/screenshots/{raw,annotated}` and `traces/`; consumers still resolve canonical artifacts through the Run Artifact Manifest.

## Self-review

- Confirmed the demo server binds only loopback and all fixture URLs are same-origin.
- Confirmed Test Case Instances use fresh contexts and distinct declared viewports.
- Confirmed examples contain synthetic identifiers and no secrets or real service data.
- Confirmed intentional test failures do not make `npm run demo` fail; missing detection, cleanup failure, incomplete per-instance evidence, or invalid artifacts do.
- Confirmed unrelated existing files and prior task changes were preserved.
- No unresolved concerns.
