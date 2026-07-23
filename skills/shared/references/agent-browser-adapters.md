# Agent and browser adapters

Write deterministic test intent, selectors, inputs, and assertions. Submit bounded Test DSL cases; the runtime owns browser contexts, sequential attempts, reruns, screenshots, traces, and telemetry.

Do not use XPath, arbitrary JavaScript evaluation, hidden browser state, arbitrary shell execution, or an agent-controlled browser adapter. Each attempt gets a fresh context. Preserve runtime diagnostics when an attempt is blocked or inconclusive.

Resolve the runtime locally: project `node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`. Do not fetch or run a remote fallback.
