# QA Skills MVP Implementation Plan

## Outcome

Build a portable QA system for Codex, Claude Code, and Cursor in which coding agents provide reasoning while a model-independent TypeScript runtime validates artifacts, executes browser tests, captures evidence, and produces deterministic reports.

The system is named **QA Skills**. The npm package is `@gwinnguyen/qa-skills`, the CLI binary is `qa-skill`, and the orchestrator skill is `qa-tester`.

## MVP boundaries

Included:

- Agent-authored requirement analysis and risk-based testcase design
- Trusted test-data provisioning and cleanup hooks
- Browser execution through Playwright
- Chromium default execution, with Firefox and WebKit support when installed
- Desktop and emulated mobile viewports
- Evidence capture, capture-time redaction, screenshot annotation, console/network telemetry, and traces
- Product bugs, test incidents, environment incidents, and investigation findings
- Deterministic coverage evaluation, release gates, retest, regression, and exploratory workflows
- Portable Agent Skills installation for Codex, Claude Code, and Cursor
- English canonical artifacts and English/Vietnamese Markdown projections

Excluded:

- Embedded LLM or model-provider integration
- API-only, native mobile, desktop, real-device, or distributed test execution
- Real payments, destructive external actions, and production mutations
- Jira/Linear/Backlog integration
- Cloud artifact storage, dashboard UI, visual-diff AI, and automatic PR comments
- Parallel test workers and multi-agent concurrency
- Artifact pruning and schema migration tooling

## Architecture

```text
Coding agent
  -> portable Skill Adapter
     -> Agent Draft
        -> QA Runtime validation/canonicalization
           -> Canonical Artifact in Run Workspace

QA Runtime
  -> typed QA Operations
  -> Playwright Runtime Browser Driver
  -> Evidence/annotation pipeline
  -> Artifact validator
  -> Coverage and release gates
  -> JSON artifacts and Markdown projections
```

The runtime never calls an LLM. Agent-authored and runtime-produced artifacts share versioned JSON Schema contracts.

## Repository layout

```text
/
├── CONTEXT.md
├── README.md
├── LICENSE
├── NOTICE
├── CONTRIBUTING.md
├── SECURITY.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── qa.config.example.yaml
├── docs/
│   ├── IMPLEMENTATION_PLAN.md
│   └── adr/
├── skills/
│   ├── qa-tester/
│   ├── requirement-analyzer/
│   ├── testcase-designer/
│   ├── test-data-manager/
│   ├── browser-test-executor/
│   ├── evidence-collector/
│   ├── bug-reporter/
│   └── qa-report-generator/
├── shared/
│   ├── schemas/
│   ├── templates/
│   └── rules/
├── src/
│   ├── contracts/
│   ├── core/
│   ├── browser/playwright/
│   ├── operations/
│   └── cli/
├── scripts/
│   ├── annotate-screenshot.ts
│   ├── create-run.ts
│   ├── generate-report.ts
│   └── validate-artifacts.ts
├── examples/
├── fixtures/
├── tests/
└── qa-results/                 # ignored
```

This is one npm package with enforced internal module boundaries. Splitting publishable workspace packages is deferred until there is a real independent consumer.

## Skill execution kinds

| Skill | Execution kind | Responsibility |
|---|---|---|
| `qa-tester` | Hybrid | Select workflow and coordinate agent-authored and runtime-backed operations |
| `requirement-analyzer` | Agent-authored | Produce requirement statements, authority, scope, risks, questions, and coverage obligations |
| `testcase-designer` | Agent-authored | Produce risk-based Test Case Candidates using the bounded Test DSL |
| `test-data-manager` | Hybrid | Select configured hooks; runtime provisions, records, and cleans owned resources |
| `browser-test-executor` | Runtime-backed | Execute approved Test Case Instances with isolated Playwright contexts |
| `evidence-collector` | Runtime-backed | Capture/attach live evidence sessions or annotate existing screenshots |
| `bug-reporter` | Hybrid | Runtime creates candidates; agent assesses impact; runtime validates and renders |
| `qa-report-generator` | Runtime-backed | Evaluate coverage/gates and render deterministic JSON/Markdown reports |

Reasoning skills create drafts and call `qa-skill artifact ingest`. `qa-skill run --skill` is reserved for runtime-backed operations.

## Runtime and contracts

- Node.js `>=22`; recommend Node 24 LTS
- ESM-only strict TypeScript
- npm with committed lockfile
- JSON Schema Draft 2020-12 as contract source of truth
- Generated TypeScript types with drift checks
- AJV validation and YAML authoring-input parsing
- Every artifact contains `artifactType`, `schemaVersion`, and `producerVersion`
- Every registered artifact has an ID, relative path, SHA-256 checksum, provenance, and relationships in `artifact-manifest.json`
- Markdown is generated from canonical JSON and is never parsed as canonical input

## Run lifecycle

Run IDs use `YYYYMMDDTHHmmssZ-<6-char-random>`. Machine timestamps are UTC. Attempts and evidence use ULIDs.

```text
CREATED -> RUNNING -> FINALIZING
                         |
                         +-> COMPLETED
                         +-> COMPLETED_WITH_FAILURES
                         +-> BLOCKED
                         +-> ABORTED
```

- Active runs use a lock and may resume only at completed operation boundaries.
- Terminal runs and their artifacts are immutable.
- Retest, regression, and cleanup retries create linked runs.
- Finalization always validates the mode-specific Artifact Profile.

Public workflow modes:

- `plan`
- `execute`
- `full`
- `exploratory`
- `retest`
- `regression`

`cleanup` is an internal maintenance mode created by the CLI cleanup command.

## Artifact layout

`artifact-manifest.json` is authoritative; directories are a human-readable convention and are created lazily.

```text
qa-results/<run-id>/
├── run.json
├── artifact-manifest.json
├── inputs/
├── requirement-analysis/
├── test-plan/
├── testcases/
├── test-data/
├── execution/
├── screenshots/raw/
├── screenshots/annotated/
├── traces/
├── videos/
├── console/
├── network/
├── bugs/
└── reports/
```

Consumers resolve typed artifact references from the manifest. Relative paths may not escape the run root.

## Requirements and testcase design

- A decisive assertion must trace to an authoritative Requirement Statement.
- Explicit user expected behavior is authoritative for that run unless tentative, exploratory, or conflicting.
- Code/current UI observations are inferred, never authoritative by themselves.
- Test Cases have stable logical IDs and immutable revisions.
- Revisions expand into parameterized Test Case Instances for data, browser, and viewport variants.
- Materially different business rules or expected behavior receive separate Test Case IDs.
- `plan` produces drafts only.
- `execute` accepts approved revisions.
- `full` may auto-promote only safe, authoritative, schema-valid non-production candidates under `auto-approve-safe`.
- Production never auto-approves candidates.

## Browser Test DSL

Initial actions:

- `open`
- `click`
- `fill`
- `select`
- `check`
- `uncheck`
- `press`
- `upload`
- `wait`

Locator priority:

1. Role
2. Label
3. Accessible name
4. Placeholder
5. Test ID
6. Stable text
7. CSS

XPath and arbitrary JavaScript evaluation are excluded from the MVP.

Initial assertions:

- Visibility
- Exact/contained text
- Value
- URL
- Element count
- Enabled/disabled
- Checked state
- Browser-observed response status
- Explicit console/network policies

Each Test Attempt receives a fresh BrowserContext. The browser process may be reused sequentially. There are no hidden whole-test retries; each rerun is a new attempt.

## Execution outcomes

Execution status and failure classification are independent.

Statuses:

- `PASSED`
- `FAILED`
- `BLOCKED`
- `INCONCLUSIVE`
- `NOT_RUN`

Classifications:

- `PRODUCT_DEFECT`
- `TEST_DEFECT`
- `ENVIRONMENT_DEFECT`
- `UNDETERMINED`
- `NONE`

`NOT_RUN` creates no Test Attempt. Attempt-status precedence is `FAILED`, `BLOCKED`, `INCONCLUSIVE`, then `PASSED`. The executor fails fast unless later steps explicitly declare safe independence.

Only `FAILED + PRODUCT_DEFECT` is automatically eligible for a Product Bug candidate.

## Evidence

Evidence policy precedence:

1. Environment safety and redaction ceiling
2. Artifact Profile minimum
3. Run policy
4. Testcase policy, which may only request more

Defaults:

- Execution/assertion log: always
- Console/network listeners: always for browser sessions
- Screenshot: on failure
- Trace: retain on failure
- Video: off

Protected environments redact before persistence. “Raw” means unannotated, sanitized evidence. Failed or unsafe redaction creates an Evidence Gap.

Screenshot metadata records capture type, image dimensions, device pixel ratio, scroll and clip origins, DOM boxes in CSS page coordinates, and normalized image-pixel boxes. The annotator uses Sharp with a validated SVG overlay and never guesses coordinates.

Standalone evidence operations:

- `capture` a new live Browser Evidence Session
- `attach` to an active runtime session
- `annotate` an existing screenshot with provenance

Closed sessions cannot yield retroactive console/network evidence.

## Test data and safety

- Test data uses traceable run-based names.
- The manager invokes only trusted, pre-registered Test Data Hooks.
- Testcases reference hook IDs and never contain generated shell strings.
- Every created Test Resource has explicit ownership and an idempotent cleanup action.
- Cleanup runs operate only on resources owned by the source run.
- `qa-skill cleanup` never deletes QA artifacts.

Environment Profiles classify targets as local, test, staging, or production.

- Production is denied by default.
- `--allow-production-readonly` permits only `sideEffect: none`.
- Production performs no seed/cleanup and persists evidence only when redaction is safe.
- External actions require scoped External Effect Permits.
- Real payments and destructive external actions remain prohibited in the MVP.
- Credentials and browser sessions are external Secret References resolved in memory and scrubbed from artifacts.

## Defects and incidents

- A normal Reproduction Set contains two total attempts, including the original failure.
- Unsafe reruns are omitted with a reason.
- Bug IDs use `BUG-<FEATURE>-<RUN_SUFFIX>-<NNN>`.
- Fingerprints consolidate duplicates only within one run and suggest possible duplicates across runs.
- Bug reporting is hybrid:
  - `NEEDS_TRIAGE` has no severity value and records open questions.
  - `TRIAGED` uses `Blocker | Critical | Major | Minor | Trivial`.
- QA owns severity and only recommends remediation priority (`P0`–`P3`).
- Test priority is a separate `critical | high | medium | low` field.
- Test defects create Test Incidents.
- Environment defects create Environment Incidents.
- Unknown causes create Investigation Findings.

## Coverage, regression, and release gates

Coverage is based on required Coverage Obligations, not testcase count.

- Obligations include requirement, role, behavior, browser, viewport, accessibility method, and risk dimensions.
- Only qualifying passed attempts satisfy obligations.
- Out-of-scope dimensions remain explicit.
- Automated accessibility never implies manual screen-reader or cognitive coverage.
- Viewport emulation never implies real-device coverage.

Regression selection uses, in order:

1. Requirement-to-test mappings
2. Code-surface-to-feature mappings
3. Declared affected-area dependencies
4. Git diff path/route/symbol/import heuristics
5. User-provided change scope

Every selection has a reason and confidence. Unmapped Change Risks prevent a complete-regression claim.

Release recommendations come from deterministic gates:

- `NOT_READY`
- `READY_WITH_RISKS`
- `READY`

AI may explain but not change the verdict. Authorized Release Overrides are separate artifacts.

## Retest and exploratory workflows

Retest produces a verdict independent from adjacent regression:

- `FIXED`
- `NOT_FIXED`
- `PARTIALLY_FIXED`
- `CANNOT_VERIFY`
- `INTERMITTENT`

A fixed original bug may coexist with a failing Regression Outcome and a `NOT_READY` release recommendation.

Exploratory mode requires an Exploration Charter with mission, scope, heuristics, safety rules, budget, and stop conditions. It creates observations and requirement/testcase candidates. Without authoritative expected behavior, findings do not become failed tests or satisfy coverage.

## CLI

Commands:

- `init`
- `run`
- `artifact ingest`
- `validate`
- `annotate`
- `report`
- `cleanup`
- `install`
- `update`
- `verify`
- `uninstall`
- `skills list`

Config discovery:

1. Explicit `--config`
2. Nearest `qa.config.yaml` up to repository root
3. Safe built-in defaults

Configuration is declarative YAML. Safety classification, permits, gates, profiles, and trusted hooks cannot be overridden by model-generated free text.

Exit codes:

- `0`: successful operation with no required QA failure
- `1`: valid completion with failures/unmet obligations
- `2`: blocked run
- `3`: invalid input/config/schema/artifact
- `4`: safety or authorization denial
- `5`: aborted run or internal error

Report generation exits zero when rendering succeeds even if the report recommendation is `NOT_READY`.

## Skill distribution

One canonical standards-compatible Skill Bundle is copied into agent-specific project or user discovery roots.

- The installer records source version, target, runtime compatibility, and file checksums.
- Update overwrites only files unchanged since installation.
- Uninstall deletes only tracked, unchanged files.
- Drift is reported as missing, modified, unexpected, or valid.
- `--force` is explicit and creates a backup.
- Skills resolve a project-local binary first, then `qa-skill` on `PATH`.
- Skills never download or execute a remote `npx` package during QA execution.

## Localization

- Everything authored in this repository is English, including commit messages and comments.
- JSON artifacts are never localized.
- Markdown projections support `en` and `vi`, defaulting to English. This is the sole place a language other than English appears, and it is product output rather than repository prose.
- Agent replies follow the user’s language independently of artifact locale.

## Implementation phases

### Phase 1 — Foundation

- Package/tooling, config loader, schemas, generated types, IDs
- Run Workspace, lifecycle, locking, manifest, checksums
- Artifact Profiles and validator
- CLI shell and exit codes

Gate: typecheck, lint, schema tests, lifecycle/manifest unit tests, and CLI smoke tests pass.

### Phase 2 — Executable browser slice

- Test DSL and validation
- Playwright driver with isolated contexts
- Step execution and deterministic aggregation
- Console/network collection
- Screenshot capture, geometry, redaction boundary, and annotation
- Minimal JSON/Markdown report

Gate: a local passing fixture testcase and evidence validation pass.

### Phase 3 — Expected-failure demo

- Local fixture app with a deterministic visual validation defect
- Deterministic console error and failed request
- Failure screenshots, trace, Bug Candidate, and report
- Expected-failure harness exits zero only when the framework correctly detects and validates the defect artifacts

Gate: `npm run demo` and Chromium integration tests pass.

### Phase 4 — Full lifecycle

- Requirement and testcase draft ingestion
- Authority and approval gates
- Coverage Profiles and Obligations
- Trusted data hooks, resource manifests, and Cleanup Runs
- Bug triage, incidents, deterministic release gates, and localized reports

Gate: full mode completes against a non-production fixture with valid end-to-end artifacts.

### Phase 5 — Advanced workflows

- Exploration Charters and findings
- Retest verdicts and linked reproduction sets
- Regression selection, confidence, exclusions, and unmapped risks

Gate: exploratory, retest, and regression Artifact Profiles pass integration scenarios.

### Phase 6 — Distribution hardening

- All eight Skill Adapters and progressive references
- Cross-agent installer/update/verify/uninstall
- Windows path and installer tests
- English/Vietnamese docs and examples
- Apache-2.0 license and governance files

Gate: the complete CI acceptance matrix passes.

## CI acceptance matrix

- Ubuntu, Node 22 and 24: typecheck, lint, unit, schema/examples, CLI
- Windows, Node 24: paths, init, installer lifecycle, unit
- Ubuntu, Node 24, Chromium: browser integration and expected-failure demo
- Skill validation for Codex, Claude Code, and Cursor target layouts
- Generated types/projections drift check
- Secret scan and sanitized-example validation

Optional jobs install Firefox/WebKit and may run on macOS.

## Definition of done

- All eight skills are independently invokable through their declared Execution Kind.
- `qa-tester` composes every public workflow mode.
- Playwright executes a validated Test Case Instance with explicit outcomes.
- A deliberate fixture defect produces sanitized raw and annotated screenshots, logs, trace, Bug Candidate/report, and QA report.
- Artifact validation catches missing, invalid, orphaned, or checksum-mismatched outputs.
- Test data is traceable and cleanup is retryable through linked Cleanup Runs.
- Coverage and release recommendations are deterministic and explainable.
- Unit, integration, expected-failure demo, cross-platform installer, schema, and documentation tests pass.
- README documents Codex, Claude Code, and Cursor setup and standalone/full examples.
- No credentials, sensitive evidence, or generated QA results are committed.

