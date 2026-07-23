---
name: bug-reporter
description: Generate deduplicated, reproducible QA bug reports only from failed product-defect attempts and registered evidence. Use when triaging failures, creating bug candidates, or preparing retest inputs.
---

# Bug reporter

Execution kind: runtime-backed. Read [artifact contracts](../shared/references/artifact-contracts.md) and [safety](../shared/references/safety.md). Let the runtime classify failures and generate reports; do not label a test, environment, or blocked failure as a product defect without its registered evidence.

Resolve `./node_modules/.bin/qa-skill` before `qa-skill` on `PATH`. Stop if unavailable and never use remote `npx`.

Example — standalone execution outcome:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" workflow run --input inputs/full-workflow.json
```

Expected outputs are runtime-owned incidents and `bug-report` artifacts only for qualifying failures. Example — full run: run `"$QA_SKILL" workflow run --input inputs/full-workflow.json` to derive reports.
