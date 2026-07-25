---
name: testcase-designer
description: Design deterministic, traceable browser test cases from approved requirements and coverage obligations. Use when creating, revising, parameterizing, or reviewing QA test cases.
---

# Testcase designer

Execution kind: agent-authored. Read [artifact contracts](../shared/references/artifact-contracts.md), [safety](../shared/references/safety.md), and [browser adapters](../shared/references/agent-browser-adapters.md). Draft bounded `test-case` artifacts with stable selectors and declared side effects; leave unsupported browser work to the runtime.

Resolve `./node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`. Stop if unavailable and never use remote `npx`. Import completed testcase drafts only as part of an atomic planning bootstrap.

Example — add a case:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" workflow bootstrap --root . --environment-file environment.json --requirement-file drafts/requirements.json --plan-file drafts/plan.json --test-case-file drafts/login-case.json --coverage-file drafts/coverage.json
```

PowerShell:

```powershell
$QaSkill = Join-Path $PWD "node_modules/.bin/qa-skill.cmd"
if (-not (Test-Path $QaSkill)) { $QaSkill = (Get-Command qa-skill -ErrorAction Stop).Source }
& $QaSkill workflow bootstrap --root . --environment-file environment.json --requirement-file drafts/requirements.json --plan-file drafts/plan.json --test-case-file drafts/login-case.json --coverage-file drafts/coverage.json
```

Example — standalone: bootstrap the complete planning bundle and validate the terminal `plan` profile.

Example — full run: register approved cases, scaffold `full-workflow.json` from the returned source run ID, then run it.
