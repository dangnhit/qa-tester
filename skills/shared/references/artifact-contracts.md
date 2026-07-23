# Artifact contracts

Treat JSON schemas in `shared/schemas/` as authoritative. Keep canonical artifacts immutable after registration, use English enum values and UTC timestamps, and preserve declared relationships and provenance.

Create drafts only for agent-authored planning artifacts. Ingest each draft through `qa-skill artifact ingest`; do not copy it into a run directory manually. Let the runtime create attempts, evidence, defects, release gates, and reports.

Validate the profile that matches the run (`plan`, `execute`, `full`, `exploratory`, `retest`, `regression`, or `cleanup`) before reporting success. Treat validation diagnostics as facts, not content to repair silently.
