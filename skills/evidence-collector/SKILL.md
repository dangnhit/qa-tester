---
name: evidence-collector
description: Collect and validate redacted, immutable QA evidence and evidence gaps for browser attempts. Use when capturing screenshots, traces, logs, telemetry, or explaining unavailable evidence.
---

# Evidence collector

Execution kind: runtime-backed. Read [safety](../shared/references/safety.md), [artifact contracts](../shared/references/artifact-contracts.md), and [browser adapters](../shared/references/agent-browser-adapters.md). Ask the runtime to capture and redact evidence; record an evidence gap instead of persisting unsafe pixels or secrets.

Resolve `./node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`; otherwise stop with setup guidance. Never use remote `npx`.

Example — check evidence completeness:

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
"$QA_SKILL" validate --root qa-results --run-id RUN_ID --profile execute
```

Example — standalone: retain one safe registered evidence bundle or evidence gap for an executed attempt.

Example — full run: retain registered evidence or gaps for runtime defect and report generation after validation.
