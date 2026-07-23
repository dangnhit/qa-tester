# Agent and browser adapters

Write deterministic test intent, selectors, inputs, and assertions. Submit bounded Test DSL cases; the runtime owns browser contexts, sequential attempts, reruns, screenshots, traces, and telemetry.

Do not use XPath, arbitrary JavaScript evaluation, hidden browser state, arbitrary shell execution, or an agent-controlled browser adapter. Each attempt gets a fresh context. Preserve runtime diagnostics when an attempt is blocked or inconclusive.

Resolve the runtime locally: project `node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`, then run `qa-skill runtime verify --range ">=0.1.0 <1.0.0"`. Do not fetch or run a remote fallback. Create a real input with `qa-skill workflow scaffold --root . --mode full --output full-workflow.json --source-root . --source-run-id SOURCE_RUN_ID`, then run `qa-skill workflow run --input full-workflow.json`. Its JSON contains `root`, `mode`, an environment profile, and exact registered bundle references. The command builds local browser/data/evidence adapters, calls public `createQaTester`, and prints registered outputs.

For a local-package API integration, run this complete plan-only adapter after creating `workflow.json` with valid registered bundle references:

```js
import { createQaTester } from "@vigentix/qa-skills";
import input from "./workflow.json" with { type: "json" };
console.log(await createQaTester({})(input));
```
