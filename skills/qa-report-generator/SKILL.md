---
name: qa-report-generator
description: Generate an auditable QA execution report and deterministic release recommendation from registered run artifacts. Use when summarizing a QA run, reviewing release readiness, or rendering English or Vietnamese QA reports.
---

# QA report generator

Execution kind: runtime-backed. Read [artifact contracts](../shared/references/artifact-contracts.md), [safety](../shared/references/safety.md), and [recovery](../shared/references/recovery.md). Use registered canonical JSON as the source of truth; let the runtime derive Markdown and the release recommendation. Do not hand-edit a release decision.

Resolve `./node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`; stop with setup guidance if absent. Never use remote `npx`.

Example — full-workflow run producing this skill's QA report:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" runtime verify --range ">=0.1.0 <1.0.0"
SOURCE_RUN_ID="$("$QA_SKILL" workflow bootstrap --root . --environment-file environment.json --requirement-file drafts/requirements.json --plan-file drafts/plan.json --test-case-file drafts/case.json --coverage-file drafts/coverage.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).runId')"
"$QA_SKILL" workflow scaffold --root . --mode full --output full-workflow.json --source-root . --source-run-id "$SOURCE_RUN_ID"
"$QA_SKILL" workflow run --input full-workflow.json
```

PowerShell:

```powershell
$QaSkill = Join-Path $PWD "node_modules/.bin/qa-skill.cmd"
if (-not (Test-Path $QaSkill)) { $QaSkill = (Get-Command qa-skill -ErrorAction Stop).Source }
& $QaSkill runtime verify --range ">=0.1.0 <1.0.0"
$Bootstrap = (& $QaSkill workflow bootstrap --root . --environment-file environment.json --requirement-file drafts/requirements.json --plan-file drafts/plan.json --test-case-file drafts/case.json --coverage-file drafts/coverage.json | ConvertFrom-Json)
& $QaSkill workflow scaffold --root . --mode full --output full-workflow.json --source-root . --source-run-id $Bootstrap.runId
& $QaSkill workflow run --input full-workflow.json
```

Expected outputs are a deterministic `release-gate` and `qa-execution-report`. Check `releaseRecommendation` in the printed JSON, not just the exit code — see [recovery](../shared/references/recovery.md). Example — full run: scaffold `full-workflow.json` from the same captured source run ID, then run it.
