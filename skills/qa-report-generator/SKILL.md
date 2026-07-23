---
name: qa-report-generator
description: Generate an auditable QA execution report and deterministic release recommendation from registered run artifacts. Use when summarizing a QA run, reviewing release readiness, or rendering English or Vietnamese QA reports.
---

# QA report generator

Execution kind: runtime-backed. Read [artifact contracts](../shared/references/artifact-contracts.md) and [safety](../shared/references/safety.md). Use registered canonical JSON as the source of truth; let the runtime derive Markdown and the release recommendation. Do not hand-edit a release decision.

Resolve `./node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`; stop with setup guidance if absent. Never use remote `npx`.

Example — validate report readiness:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" validate --root qa-results --run-id RUN_ID --profile full
```

Example — standalone: render only from an already validated run; use the full profile when including planning, evidence, defects, and the release gate.
