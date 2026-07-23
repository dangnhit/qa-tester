---
name: browser-test-executor
description: Execute approved bounded browser Test DSL cases with fresh isolated contexts and auditable attempts. Use when running browser tests, reruns, regression checks, or blocked execution diagnostics.
---

# Browser test executor

Execution kind: runtime-backed. Read [browser adapters](../shared/references/agent-browser-adapters.md), [safety](../shared/references/safety.md), and [artifact contracts](../shared/references/artifact-contracts.md). Invoke the runtime; do not drive a browser through arbitrary JavaScript, XPath, or untyped shell commands.

Resolve `./node_modules/.bin/qa-skill` before `qa-skill` on `PATH`. Stop if neither is compatible; never use remote `npx`.

Example — standalone execution:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" workflow run --input inputs/execute-workflow.json
```

Expected outputs are registered `test-result` attempts and evidence or gaps. Example — full run: run `"$QA_SKILL" workflow run --input inputs/full-workflow.json`.

Example — full run: pass registered attempts and runtime evidence to `qa-report-generator` after `--profile full` validates.
