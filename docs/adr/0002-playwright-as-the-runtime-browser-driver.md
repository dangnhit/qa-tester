# Use Playwright as the runtime browser driver

The MVP uses Playwright as its only executable **Runtime Browser Driver**. Built-in agent browsers and Playwright MCP remain **Agent Browser Adapters** governed by skill-level policy because the TypeScript runtime cannot reliably control tools owned by Codex, Claude Code, or Cursor; both paths must still produce artifacts conforming to the same contract.
