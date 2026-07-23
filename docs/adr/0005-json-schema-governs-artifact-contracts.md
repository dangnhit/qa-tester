# Use JSON Schema as the artifact contract source of truth

JSON Schema Draft 2020-12 files govern all machine-readable **Artifact Contracts**, canonical run artifacts are JSON, and TypeScript types are generated and checked for drift. YAML remains an authoring format that is parsed and snapshotted as validated JSON, while Markdown reports and matrices are derived **Artifact Projections**; versioned schemas make breaking compatibility explicit instead of allowing formats and types to diverge silently.
