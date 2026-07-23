# Agent and browser adapters

Write deterministic test intent, selectors, inputs, and assertions. Submit bounded Test DSL cases; the runtime owns browser contexts, sequential attempts, reruns, screenshots, traces, and telemetry.

Do not use XPath, arbitrary JavaScript evaluation, hidden browser state, arbitrary shell execution, or an agent-controlled browser adapter. Each attempt gets a fresh context. Preserve runtime diagnostics when an attempt is blocked or inconclusive.

Resolve the runtime locally: project `node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`. Do not fetch or run a remote fallback. Run a package-owned local workflow with `qa-skill workflow run --input inputs/full-workflow.json`; its JSON input contains `root`, `mode`, `environmentProfile`, registered `bundle` references, and optional runtime IDs. The command builds local browser/data/evidence adapters, calls public `createQaTester`, and prints registered outputs.

For a local-package API integration, run this complete plan-only adapter after creating `workflow.json` with valid registered bundle references:

```js
import { createQaTester } from "@vigentix/qa-skills";
import input from "./workflow.json" with { type: "json" };
console.log(await createQaTester({})(input));
```
