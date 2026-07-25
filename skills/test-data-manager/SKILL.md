---
name: test-data-manager
description: Prepare, bind, and clean up declared QA test data through trusted runtime hooks. Use when a test run needs fixtures, secret references, data setup, or cleanup verification.
---

# Test data manager

Execution kind: runtime-backed. Read [safety](../shared/references/safety.md), [artifact contracts](../shared/references/artifact-contracts.md), and [recovery](../shared/references/recovery.md). Declare data needs and secret references only; invoke trusted runtime hooks for setup and cleanup. Never expose secret values or run undeclared destructive actions.

Resolve the local runtime as `./node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`; stop with setup guidance if unavailable. Never use remote `npx`.

Example — full data-backed run:

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

Expected full outputs include a runtime-owned `test-data-manifest`, attempts, evidence, and report. Example — standalone: declare bindings and ingest planning drafts; do not run setup outside the workflow.
