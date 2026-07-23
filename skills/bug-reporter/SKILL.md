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
"$QA_SKILL" runtime verify --range ">=0.1.0 <1.0.0"
"$QA_SKILL" workflow scaffold --root . --mode full --output full-workflow.json --source-root . --source-run-id SOURCE_RUN_ID
"$QA_SKILL" workflow run --input full-workflow.json
```

PowerShell:

```powershell
$QaSkill = Join-Path $PWD "node_modules/.bin/qa-skill.cmd"
if (-not (Test-Path $QaSkill)) { $QaSkill = (Get-Command qa-skill -ErrorAction Stop).Source }
& $QaSkill runtime verify --range ">=0.1.0 <1.0.0"
& $QaSkill workflow scaffold --root . --mode full --output full-workflow.json --source-root . --source-run-id SOURCE_RUN_ID
& $QaSkill workflow run --input full-workflow.json
```

Expected outputs are runtime-owned incidents and `bug-report` artifacts only for qualifying failures. Example — full run: scaffold `full-workflow.json` from `SOURCE_RUN_ID`, then run it to derive reports.
