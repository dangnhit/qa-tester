---
name: test-data-manager
description: Prepare, bind, and clean up declared QA test data through trusted runtime hooks. Use when a test run needs fixtures, secret references, data setup, or cleanup verification.
---

# Test data manager

Execution kind: runtime-backed. Read [safety](../shared/references/safety.md) and [artifact contracts](../shared/references/artifact-contracts.md). Declare data needs and secret references only; invoke trusted runtime hooks for setup and cleanup. Never expose secret values or run undeclared destructive actions.

Resolve the local runtime as `./node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`; stop with setup guidance if unavailable. Never use remote `npx`.

Example — verify a data-backed run:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" validate --root qa-results --run-id RUN_ID --profile full
```

Example — standalone: validate the declared data bindings with the run's required profile before browser execution.
