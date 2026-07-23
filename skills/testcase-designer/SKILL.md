---
name: testcase-designer
description: Design deterministic, traceable browser test cases from approved requirements and coverage obligations. Use when creating, revising, parameterizing, or reviewing QA test cases.
---

# Testcase designer

Execution kind: agent-authored. Read [artifact contracts](../shared/references/artifact-contracts.md), [safety](../shared/references/safety.md), and [browser adapters](../shared/references/agent-browser-adapters.md). Draft bounded `test-case` artifacts with stable selectors and declared side effects; leave unsupported browser work to the runtime.

Resolve `./node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`. Stop if unavailable and never use remote `npx`. Ingest every completed draft with the local runtime.

Example — add a case:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" artifact ingest --root qa-results --run-id RUN_ID --type test-case --file drafts/login-case.json
```

Example — standalone: ingest one approved test case and validate the `plan` profile.

Example — full run: register approved cases, then run `"$QA_SKILL" workflow run --input inputs/full-workflow.json`.
