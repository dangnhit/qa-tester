---
name: browser-test-executor
description: Execute approved bounded browser Test DSL cases with fresh isolated contexts and auditable attempts. Use when running browser tests, reruns, regression checks, or blocked execution diagnostics.
---

# Browser test executor

Execution kind: runtime-backed. Read [browser adapters](../shared/references/agent-browser-adapters.md), [safety](../shared/references/safety.md), and [artifact contracts](../shared/references/artifact-contracts.md). Invoke the runtime; do not drive a browser through arbitrary JavaScript, XPath, or untyped shell commands.

Resolve `./node_modules/.bin/qa-skill` before `qa-skill` on `PATH`. Stop if neither is compatible; never use remote `npx`.

Example — validate completed execution:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" validate --root qa-results --run-id RUN_ID --profile execute
```

Example — standalone: validate a completed execute profile before recording the attempt outcome.

Example — full run: pass registered attempts and runtime evidence to `qa-report-generator` after `--profile full` validates.
