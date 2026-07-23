# Task 7 review corrections

The release gate and report are now derived from the complete immutable workspace manifest at generation, registration, and workspace opening. The snapshot includes coverage, latest bug revisions, incidents, evidence gaps, cleanup leaks, validation facts, and shared blockers; a fabricated or rechecksummed gate is rejected.

Product bugs now preserve immutable same-run revision chains under one run-scoped bug ID. Revisions supersede their predecessor and merge attempt, reproduction, and evidence references. Cross-run possible duplicates require a checksum-bound source artifact in a separate verified workspace. Expected and actual values are bound to the approved testcase revision and registered observation; absent observation is explicit and carries an open question.

Incidents accept registered evidence or an exact-attempt Evidence Gap. Focused boundary tests, generated-contract checks, typecheck, lint, and the full suite pass.
