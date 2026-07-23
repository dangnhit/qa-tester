---
name: qa-report-generator
description: Generate an auditable QA execution report and deterministic release recommendation from registered run artifacts. Use when summarizing a QA run, reviewing release readiness, or rendering English or Vietnamese QA reports.
---

# QA report generator

Execution kind: runtime-backed. Read [artifact contracts](../shared/references/artifact-contracts.md) and [safety](../shared/references/safety.md). Use registered canonical JSON as the source of truth; let the runtime derive Markdown and the release recommendation. Do not hand-edit a release decision.

Resolve `./node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`; stop with setup guidance if absent. Never use remote `npx`.

Example — standalone execution report:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" runtime verify --range ">=0.1.0 <1.0.0"
"$QA_SKILL" workflow scaffold --root . --mode full --output full-workflow.json --source-root . --source-run-id SOURCE_RUN_ID
"$QA_SKILL" workflow run --input full-workflow.json
```

Expected outputs are a deterministic `release-gate` and `qa-execution-report`. Example — full run: scaffold `full-workflow.json` from `SOURCE_RUN_ID`, then run it.
