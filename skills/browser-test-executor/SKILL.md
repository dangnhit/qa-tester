---
name: browser-test-executor
description: Execute approved bounded browser Test DSL cases with fresh isolated contexts and auditable attempts. Use when running browser tests, reruns, regression checks, or blocked execution diagnostics.
---

# Browser test executor

Execution kind: runtime-backed. Read [browser adapters](../shared/references/agent-browser-adapters.md), [safety](../shared/references/safety.md), [artifact contracts](../shared/references/artifact-contracts.md), and [recovery](../shared/references/recovery.md). Invoke the runtime; do not drive a browser through arbitrary JavaScript, XPath, or untyped shell commands.

This skill owns the **browser** Execution Surface only. Five of the remaining six — `api`, `unit`, `integration`, `performance`, `security` — are reached by observing a committed external suite: see [observed execution](../shared/references/observed-execution.md) for `qa-skill execute playwright`, the in-spec identity tag it requires, and what the git anchor refuses. A spec tagged `browser` there is refused and sent back here, because a Playwright JSON report names neither the engine nor the viewport a browser result must record. The seventh, `manual`, has no executor in either lane: an obligation declaring it stays authorable and explicitly unmet until a person records a Human Attestation (`qa-skill attestation record`).

Resolve `./node_modules/.bin/qa-skill` before `qa-skill` on `PATH`. Stop if neither is compatible; never use remote `npx`.

Example — full-workflow run producing this skill's registered attempts:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" runtime verify --range ">=0.1.0 <1.0.0"
SOURCE_RUN_ID="$("$QA_SKILL" workflow bootstrap --root . --environment-file environment.json --requirement-file drafts/requirements.json --plan-file drafts/plan.json --test-case-file drafts/case.json --coverage-file drafts/coverage.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).runId')"
"$QA_SKILL" workflow scaffold --root . --mode execute --output execute-workflow.json --source-root . --source-run-id "$SOURCE_RUN_ID"
"$QA_SKILL" workflow run --input execute-workflow.json
```

PowerShell:

```powershell
$QaSkill = Join-Path $PWD "node_modules/.bin/qa-skill.cmd"
if (-not (Test-Path $QaSkill)) { $QaSkill = (Get-Command qa-skill -ErrorAction Stop).Source }
& $QaSkill runtime verify --range ">=0.1.0 <1.0.0"
$Bootstrap = (& $QaSkill workflow bootstrap --root . --environment-file environment.json --requirement-file drafts/requirements.json --plan-file drafts/plan.json --test-case-file drafts/case.json --coverage-file drafts/coverage.json | ConvertFrom-Json)
& $QaSkill workflow scaffold --root . --mode execute --output execute-workflow.json --source-root . --source-run-id $Bootstrap.runId
& $QaSkill workflow run --input execute-workflow.json
```

Expected outputs are registered `test-result` attempts and evidence or gaps. Example — full run: scaffold `full-workflow.json` from the same captured source run ID, then run it.

Example — full run: pass registered attempts and runtime evidence to `qa-report-generator` after `--profile full` validates.
