# QA Skills

QA Skills is a portable, deterministic quality-assurance runtime for Codex, Claude Code, and Cursor. It combines versioned artifact contracts, a TypeScript CLI, a Playwright Runtime Browser Driver, evidence and defect operations, release-gate reporting, and one canonical cross-agent Skill Bundle.

The runtime never calls an LLM. Agents may author requirement and testcase drafts, while QA Skills validates, registers, executes, and reports immutable canonical artifacts.

## Requirements

- Node.js 22 or 24
- npm
- A locally installed Chromium binary for browser execution

QA execution never downloads a runtime or browser implicitly.

## Install and verify

From a checkout:

```bash
npm ci
npm run build
npx playwright install chromium
node dist/src/cli/index.js runtime verify --range ">=0.1.0 <1.0.0"
```

For a consuming project, install this package from a pinned local path or approved registry version, then use `node_modules/.bin/qa-skill`. Do not use a remote `npx` fallback during QA execution.

Initialize a project:

```bash
qa-skill init
```

This creates `qa.config.yaml` if absent and ensures `qa-results/` is ignored. The minimal config is:

```yaml
version: 1
resultsDirectory: qa-results
```

Project configuration and Test Data Hooks must be reviewed source files. Store only Secret References in inputs; resolve secret values in memory at execution time.

## Deterministic demo

```bash
npm ci
npx playwright install chromium
npm run demo
```

The demo binds an ephemeral `127.0.0.1` port and makes no external request. Its fixture deliberately leaves an authoritative validation message empty, emits `QA_DEMO_CONSOLE_ERROR`, and calls a local endpoint that deterministically fails. The runtime executes Chromium desktop and emulated mobile Test Case Instances, records traces, sanitized raw and annotated screenshots, console/network telemetry, product Bug Candidates, a QA report, and a validated Full Artifact Profile. It also creates one owned synthetic Test Resource and proves its lifecycle through a separate linked Cleanup Run.

The command exits `0` only when the intentional defect is detected as `FAILED + PRODUCT_DEFECT`, the QA Run is `COMPLETED_WITH_FAILURES`, the release recommendation is `NOT_READY`, each desktop/mobile attempt has its required evidence, cleanup completes, and all expected artifacts validate. Canonical run data is written under `qa-results/`; convenient copied evidence projections are written under `demo-artifacts/`. Both are ignored.

## CLI reference

Commands that produce output use machine-readable JSON unless noted. Successful `qa-skill init` and `qa-skill artifact ingest` are intentionally silent on stdout.

| Command | Purpose |
| --- | --- |
| `qa-skill init` | Create minimal project config and ignore `qa-results/`; success has no stdout. |
| `qa-skill skills list` | List the orchestrator and standalone Skill Adapters with execution kinds. |
| `qa-skill skills install --agent <codex\|claude\|cursor> [--target project\|user]` | Install a checksummed copy of the canonical Skill Bundle. |
| `qa-skill skills verify --agent ...` | Detect missing, modified, or unexpected installed files. |
| `qa-skill skills update --agent ... [--force]` | Refresh an installation; drift is preserved unless force is explicit. |
| `qa-skill skills uninstall --agent ...` | Remove owned unchanged files and report drift leftovers. |
| `qa-skill runtime verify [--range <semver>]` | Verify the local runtime binding and compatibility. |
| `qa-skill workflow scaffold --root <path> --mode <mode> --output <json> [--environment-file <json>] [--source-root <path> --source-run-id <id>]` | Create a closed workflow input using explicit checksum-bound sources. |
| `qa-skill workflow run --input <json>` | Run the closed public QA Tester workflow with local runtime services. |
| `qa-skill artifact ingest --root <path> --run-id <id> --type <type> --file <json-or-yaml> [--relationship <id>]` | Validate and register an Agent Draft as a Canonical Artifact; success has no stdout. |
| `qa-skill validate --root <path> --run-id <id> [--profile <name>]` | Reopen and validate checksums, relationships, schemas, and an optional Artifact Profile. |

Public workflow modes are `plan`, `execute`, `full`, `exploratory`, `retest`, and `regression`. `cleanup` is a linked maintenance-run profile created through the cleanup operation; it is not accepted by the public workflow runner.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Command completed; for the demo, the expected defect and artifacts were detected. |
| `1` | Validation, installation, cleanup, or coverage obligations remain unmet. |
| `2` | A live lock or other recoverable blocker prevented progress. |
| `3` | Input, schema, profile, command, or compatibility data is invalid. |
| `4` | A path, symlink, installer, environment, or side-effect safety rule denied the action. |
| `5` | Execution aborted or an internal failure occurred. |

## Skill use

The `qa-tester` Skill Adapter orchestrates the Full QA Lifecycle. Ask an agent to use it when requirements, test design, controlled data, browser execution, evidence, defects, and reporting should stay in one immutable QA Run.

Standalone adapters call the same typed QA Operations:

- `requirement-analyzer` — agent-authored requirement authority analysis
- `testcase-designer` — agent-authored bounded Test DSL and coverage design
- `test-data-manager` — runtime-backed trusted setup and idempotent cleanup
- `browser-test-executor` — runtime-backed Playwright execution
- `evidence-collector` — runtime-backed live-session capture and redaction
- `bug-reporter` — runtime-backed defect eligibility, reproduction, and triage
- `qa-report-generator` — runtime-backed release gate and report projections

Example agent request:

```text
Use the qa-tester skill in full mode against the local test environment.
Treat the acceptance criteria in docs/profile.md as authoritative.
Do not perform external or destructive side effects.
```

For a standalone operation:

```text
Use the evidence-collector skill for run <run-id> and attempt <attempt-id>.
Capture only the channels permitted by the registered evidence policy.
```

## Agent-specific installation

Project installations are recommended because runtime binding and review travel with the repository:

```bash
qa-skill skills install --agent codex --target project
qa-skill skills install --agent claude --target project
qa-skill skills install --agent cursor --target project
```

The roots are `.codex/skills`, `.claude/skills`, and `.cursor/skills`. Use `--target user` for the corresponding directory under the user home. After source updates, run `skills verify`, then `skills update`; never patch an installed copy directly.

## Environment and side-effect safety

- `production` requires explicit read-only opt-in and permits only `none` side effects.
- `reversible` operations require owned Test Resources and an idempotent cleanup action.
- `external` operations require a scoped, expiring External Effect Permit.
- Destructive actions, real payments, wildcard recipients, arbitrary shell hooks, and undeclared environments are denied.
- Every browser attempt gets a fresh context. Emulated mobile is not a real-device or cross-browser claim.
- Test Data Hooks are pre-registered typed capabilities; agents do not improvise setup or cleanup commands.

## Evidence and redaction

Evidence listeners start before the actions they observe. Protected targets persist Sanitized Raw Evidence only; annotations are derived separately. Mandatory selectors or regions are masked before screenshot bytes are registered. After any secret is resolved, screenshots require provable secret-derived masking regardless of environment classification; otherwise the runtime registers an Evidence Gap without creating PNG bytes. Other unsafe captures likewise become Evidence Gaps.

Known secrets are scrubbed from errors and telemetry. Never put resolved credentials, cookies, personal data, or production payloads in testcases, examples, bug reports, or logs. The checked-in `examples/` use fixed synthetic identifiers and `.test`-style data.

## Artifact layout

The manifest, not the directory layout, is authoritative:

```text
qa-results/<run-id>/
├── run-metadata.json
├── artifact-manifest.json
├── inputs/
└── evidence/

demo-artifacts/<run-id>/
├── screenshots/raw/
├── screenshots/annotated/
└── traces/
```

Every canonical descriptor and binary is registered in the manifest with a checksum; relationships use artifact IDs. `demo-artifacts/` contains convenience copies only and is never authoritative. Consumers must not scan for the newest run or guess filenames. A completed run is immutable; retest, regression, and cleanup create linked runs.

## Troubleshooting

- **Chromium executable missing:** run `npx playwright install chromium` during setup. QA execution itself will not download it.
- **Runtime missing/incompatible:** install the pinned package locally and run `qa-skill runtime verify`; do not use a remote fallback.
- **`AWAITING_RUNTIME`:** provide the configured browser/test-data service IDs and resume the same nonterminal run.
- **Live lock:** confirm no active process owns the run; do not delete lock files blindly.
- **Artifact validation failure:** inspect normalized diagnostics, fix the canonical JSON or source draft, and generate a new artifact. Do not edit Markdown projections.
- **Evidence Gap:** repair the capture/redaction policy or selector and create a new attempt; never substitute an unregistered file.
- **Installer drift:** review `skills verify`; use `skills update --force` only after intentionally accepting local replacement.
- **Demo returns nonzero:** confirm Chromium is installed and that local loopback connections are permitted, then rerun `npm test -- tests/e2e/demo.test.ts`.

## Development and governance

Run the full local gate:

```bash
npm ci
npm run generate:types
npm run check:generated
npm run typecheck
npm run lint
npm test
npm run demo
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Licensed under Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
