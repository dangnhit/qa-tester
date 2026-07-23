---
name: bug-reporter
description: Generate deduplicated, reproducible QA bug reports only from failed product-defect attempts and registered evidence. Use when triaging failures, creating bug candidates, or preparing retest inputs.
---

# Bug reporter

Execution kind: runtime-backed. Read [artifact contracts](../shared/references/artifact-contracts.md) and [safety](../shared/references/safety.md). Let the runtime classify failures and generate reports; do not label a test, environment, or blocked failure as a product defect without its registered evidence.

Resolve `./node_modules/.bin/qa-skill` before `qa-skill` on `PATH`. Stop if unavailable and never use remote `npx`.

Example — verify defect outputs:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" validate --root qa-results --run-id RUN_ID --profile full
```

Example — standalone: validate a completed execution profile before asking the runtime to derive a defect outcome.
