# Maintain one portable skill bundle

Codex, Claude Code, and Cursor consume one canonical standards-compatible **Skill Bundle** rather than separately maintained skill definitions. The CLI copies that bundle into each agent's discovery root, records checksums in a **Skill Installation** manifest, and keeps agent-specific tool guidance in progressively disclosed references; copy-based installation avoids cross-platform and remote-workspace symlink failures while preventing source drift.
