---
name: qa-tester
description: Coordinate a bounded, evidence-backed QA run from requirements through release recommendation. Use for end-to-end QA planning, execution, retests, regressions, or exploratory browser checks.
---

# QA tester

Execution kind: hybrid. Read [safety](../shared/references/safety.md) and [artifact contracts](../shared/references/artifact-contracts.md) before acting. Use the specialist skills for their owned outputs.

Resolve the compatible local runtime in this order: `./node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`. If neither exists, stop with setup guidance; never use `npx`, a remote executable, or a substitute runtime.

Create or open one run workspace. Keep drafts agent-authored and ingest them; let the runtime execute typed browser, evidence, defect, and report work. Validate before declaring completion.

Example — full run:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" artifact ingest --root qa-results --run-id RUN_ID --type requirement-analysis --file drafts/requirements.json
"$QA_SKILL" validate --root qa-results --run-id RUN_ID --profile full
```

Example — standalone planning: use `requirement-analyzer` to draft and ingest only the analysis, then validate the `plan` profile.

This is one canonical standard `SKILL.md` per skill name for Codex, Claude, and Cursor. Deliberately omit generated `agents/` metadata because it is vendor-specific and would duplicate the portable definition.
