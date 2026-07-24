# Generate per-agent discovery shims

ADR-0006 assumed that copying the **Skill Bundle** into `.codex/skills` and `.cursor/skills` made it discoverable, but only Claude Code reads a `<root>/skills/<name>/SKILL.md` layout; Codex discovers instructions through `AGENTS.md` and Cursor through `.cursor/rules/*.mdc`, so those two installations were inert directories that `skills verify` nonetheless reported as valid. **Skill Installation** therefore now also generates a small vendor-shaped shim per agent that points at the copied skills, and `skills verify` checks the shim as part of the installation.

The shim contains no skill content — it references the canonical `SKILL.md` files — so ADR-0006's actual guarantee, that no skill definition is maintained twice, is preserved. This reverses the bundle's earlier refusal to emit vendor metadata: that refusal protected a portability claim that was never true, and paying a few generated pointer files is cheaper than either maintaining three bundles or supporting one agent.

## Consequences

Each supported agent needs its shim format tracked as it evolves, which is real per-vendor maintenance the project previously claimed to avoid. `skills verify` must fail when a shim is missing or stale, because reporting a valid installation that no agent can see is the failure this decision exists to remove.
