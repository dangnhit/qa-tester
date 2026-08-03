---
name: qa-tester
description: Coordinate a bounded, evidence-backed QA run from requirements through release recommendation. Use for end-to-end QA planning, execution, retests, regressions, or exploratory browser checks.
---

# QA tester

Execution kind: hybrid. Read [safety](../shared/references/safety.md), [artifact contracts](../shared/references/artifact-contracts.md), and [recovery](../shared/references/recovery.md) before acting. Use the specialist skills for their owned outputs.

Resolve the compatible local runtime in this order: `./node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`. If neither exists, stop with setup guidance; never use `npx`, a remote executable, or a substitute runtime.

Create or open one run workspace. Keep drafts agent-authored and ingest them; let the runtime execute typed browser, evidence, defect, and report work. Validate before declaring completion.

A run may be credited by either execution lane, or both. The runtime drives the browser itself; for any other Execution Surface it starts the project's own committed Playwright suite and records what it observed — see [observed execution](../shared/references/observed-execution.md). Never author a spec file and execute it in the same run: a Reviewed Test Suite earns coverage credit because a human merged it, and the runtime refuses a spec tree that differs from its commit.

Example — full run:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" runtime verify --range ">=1.0.0 <2.0.0"
SOURCE_RUN_ID="$("$QA_SKILL" workflow bootstrap --root . --environment-file environment.json --requirement-file drafts/requirements.json --plan-file drafts/plan.json --test-case-file drafts/case.json --coverage-file drafts/coverage.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).runId')"
"$QA_SKILL" workflow scaffold --root . --mode full --output full-workflow.json --source-root . --source-run-id "$SOURCE_RUN_ID"
"$QA_SKILL" workflow run --input full-workflow.json
```

PowerShell:

```powershell
$QaSkill = Join-Path $PWD "node_modules/.bin/qa-skill.cmd"
if (-not (Test-Path $QaSkill)) { $QaSkill = (Get-Command qa-skill -ErrorAction Stop).Source }
& $QaSkill runtime verify --range ">=1.0.0 <2.0.0"
$Bootstrap = (& $QaSkill workflow bootstrap --root . --environment-file environment.json --requirement-file drafts/requirements.json --plan-file drafts/plan.json --test-case-file drafts/case.json --coverage-file drafts/coverage.json | ConvertFrom-Json)
& $QaSkill workflow scaffold --root . --mode full --output full-workflow.json --source-root . --source-run-id $Bootstrap.runId
& $QaSkill workflow run --input full-workflow.json
```

Expected full outputs include registered attempts, evidence or gaps, bug reports, a release gate, and a QA report. Check `outcome`, `validation.valid`, and `releaseRecommendation` in the printed JSON before reporting a result — see [recovery](../shared/references/recovery.md). Example — standalone planning: use `requirement-analyzer` to draft and ingest only the analysis.

This is one canonical standard `SKILL.md` per skill name for Codex, Claude, and Cursor. Installation emits per-agent discovery shims (Codex `AGENTS.md`, Cursor `.cursor/rules/qa-skills.mdc`) that only point at these canonical `SKILL.md` files, so no skill is ever defined twice (ADR-0011).
