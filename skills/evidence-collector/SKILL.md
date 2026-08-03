---
name: evidence-collector
description: Collect and validate redacted, immutable QA evidence and evidence gaps for browser attempts. Use when capturing screenshots, traces, logs, telemetry, or explaining unavailable evidence.
---

# Evidence collector

Execution kind: runtime-backed. Read [safety](../shared/references/safety.md), [artifact contracts](../shared/references/artifact-contracts.md), [browser adapters](../shared/references/agent-browser-adapters.md), and [recovery](../shared/references/recovery.md). Ask the runtime to capture and redact evidence; record an evidence gap instead of persisting unsafe pixels or secrets.

Resolve `./node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`; otherwise stop with setup guidance. Never use remote `npx`.

Example — full-workflow run producing this skill's evidence:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" runtime verify --range ">=1.0.0 <2.0.0"
SOURCE_RUN_ID="$("$QA_SKILL" workflow bootstrap --root . --environment-file environment.json --requirement-file drafts/requirements.json --plan-file drafts/plan.json --test-case-file drafts/case.json --coverage-file drafts/coverage.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).runId')"
"$QA_SKILL" workflow scaffold --root . --mode execute --output execute-workflow.json --source-root . --source-run-id "$SOURCE_RUN_ID"
"$QA_SKILL" workflow run --input execute-workflow.json
```

PowerShell:

```powershell
$QaSkill = Join-Path $PWD "node_modules/.bin/qa-skill.cmd"
if (-not (Test-Path $QaSkill)) { $QaSkill = (Get-Command qa-skill -ErrorAction Stop).Source }
& $QaSkill runtime verify --range ">=1.0.0 <2.0.0"
$Bootstrap = (& $QaSkill workflow bootstrap --root . --environment-file environment.json --requirement-file drafts/requirements.json --plan-file drafts/plan.json --test-case-file drafts/case.json --coverage-file drafts/coverage.json | ConvertFrom-Json)
& $QaSkill workflow scaffold --root . --mode execute --output execute-workflow.json --source-root . --source-run-id $Bootstrap.runId
& $QaSkill workflow run --input execute-workflow.json
```

Expected outputs are redacted evidence descriptors/binaries or `evidence-gap` artifacts — see [recovery](../shared/references/recovery.md) for what a gap means. Example — full run: scaffold with `--mode full --source-root . --source-run-id "$SOURCE_RUN_ID"` (the same captured source run ID), then run the returned JSON.

Example — full run: retain registered evidence or gaps for runtime defect and report generation after validation.
