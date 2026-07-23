---
name: evidence-collector
description: Collect and validate redacted, immutable QA evidence and evidence gaps for browser attempts. Use when capturing screenshots, traces, logs, telemetry, or explaining unavailable evidence.
---

# Evidence collector

Execution kind: runtime-backed. Read [safety](../shared/references/safety.md), [artifact contracts](../shared/references/artifact-contracts.md), and [browser adapters](../shared/references/agent-browser-adapters.md). Ask the runtime to capture and redact evidence; record an evidence gap instead of persisting unsafe pixels or secrets.

Resolve `./node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`; otherwise stop with setup guidance. Never use remote `npx`.

Example — standalone evidence capture:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" runtime verify --range ">=0.1.0 <1.0.0"
"$QA_SKILL" workflow scaffold --root . --mode execute --output execute-workflow.json --source-root . --source-run-id SOURCE_RUN_ID
"$QA_SKILL" workflow run --input execute-workflow.json
```

PowerShell:

```powershell
$QaSkill = Join-Path $PWD "node_modules/.bin/qa-skill.cmd"
if (-not (Test-Path $QaSkill)) { $QaSkill = (Get-Command qa-skill -ErrorAction Stop).Source }
& $QaSkill runtime verify --range ">=0.1.0 <1.0.0"
& $QaSkill workflow scaffold --root . --mode execute --output execute-workflow.json --source-root . --source-run-id SOURCE_RUN_ID
& $QaSkill workflow run --input execute-workflow.json
```

Expected outputs are redacted evidence descriptors/binaries or `evidence-gap` artifacts. Example — full run: scaffold with `--mode full --source-root . --source-run-id SOURCE_RUN_ID`, then run the returned JSON.

Example — full run: retain registered evidence or gaps for runtime defect and report generation after validation.
