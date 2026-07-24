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
RUN_ID="$("$QA_SKILL" run create --root . --mode plan --environment-file environment.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).runId')"
"$QA_SKILL" artifact ingest --root . --run-id "$RUN_ID" --type requirement-analysis --file drafts/requirement-analysis.json
```

PowerShell:

```powershell
$QaSkill = Join-Path $PWD "node_modules/.bin/qa-skill.cmd"
if (-not (Test-Path $QaSkill)) { $QaSkill = (Get-Command qa-skill -ErrorAction Stop).Source }
$Run = (& $QaSkill run create --root . --mode plan --environment-file environment.json | ConvertFrom-Json)
& $QaSkill artifact ingest --root . --run-id $Run.runId --type requirement-analysis --file drafts/requirement-analysis.json
```

`run create` returns the new `runId` and closes its process lock without finalizing the workspace, so later standalone specialist skills can keep registering canonical artifacts in that run.

Example — full run: hand the registered analysis to `testcase-designer`, scaffold `full-workflow.json` from the returned source run ID, then run it.
