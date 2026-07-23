---
name: requirement-analyzer
description: Turn product requirements into traceable QA requirements and coverage obligations. Use when analyzing specifications, acceptance criteria, ambiguities, risks, or test scope.
---

# Requirement analyzer

Execution kind: agent-authored. Read [safety](../shared/references/safety.md) and [artifact contracts](../shared/references/artifact-contracts.md). Produce an explicit, provenance-marked `requirement-analysis` draft; do not invent authority for unresolved requirements.

Resolve `./node_modules/.bin/qa-skill` before `qa-skill` on `PATH`; if absent, stop with setup guidance. Never use remote `npx`. Ingest the finished draft through the local runtime.

Example — standalone analysis:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" artifact ingest --root qa-results --run-id RUN_ID --type requirement-analysis --file drafts/requirement-analysis.json
```

Example — full run: hand the registered analysis to `testcase-designer`, then run `"$QA_SKILL" workflow run --input inputs/full-workflow.json`.
