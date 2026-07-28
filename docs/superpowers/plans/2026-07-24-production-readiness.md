# Production-Readiness Plan — `@vigentix/qa-skills`

**Driving question:** Is this bundle sufficient to serve real SDLC testing as a plugin for Claude Code, Codex, and Cursor?
**Answer chosen:** make it sufficient as an **Evidence/Gate layer**, not as a browser runner. Keep the deterministic release gate, Requirement Authority model, fail-closed evidence, and safety envelope; add a lane that lets the runtime *observe* an external runner (Playwright) instead of re-implementing what Playwright already does.

Source of findings: `docs/reports/` deep review (15 agents, 14 Critical after dedup). This plan resolves the design decisions; issue IDs (D1…) map to that review.

---

## Terminology (see CONTEXT.md)

- **Execution Provenance** — the basis on which a result is accepted as *observed*, not merely asserted. Three values:
  - `runtime-execution` — the **Runtime Browser Driver** drove the browser (lane 1).
  - `runtime-observed` — the runtime spawned an external runner over a **Reviewed Test Suite** and captured its exit + output (lane 2).
  - `agent-draft` — a file handed to the runtime; reportable, **never** credits a **Coverage Obligation**.
- **Reviewed Test Suite** — committed test files outside the Test DSL; git commit identity is the human-acceptance evidence.
- **Human Attestation** — a signed claim that a non-machine evaluation happened (for manual a11y obligations).
- **Product Readiness** — maturity of QA Skills itself, distinct from a **Release Recommendation** about the system under test.

New/changed decisions: **ADR-0010** (two lanes, git-anchored observation), **ADR-0011** (per-agent discovery shims), ADR-0006 amended, ADR-0009 extended.

---

## Two lanes (ADR-0010)

| | Lane 1 — agent-authored | Lane 2 — human-authored |
|---|---|---|
| Test source | bounded **Test DSL**, agent-drafted | arbitrary Playwright spec, git-committed |
| Executor | Runtime Browser Driver (runtime drives) | external runner (runtime **spawns**, captures exit+output) |
| Provenance | `runtime-execution` | `runtime-observed` + `commitSha` + `specTreeSha256` |
| Anchor | runtime constrains every action | a human merged it; hash proves it |
| Dirty tree | n/a | **REFUSED** or downgraded to `agent-draft` |
| Credits coverage? | yes | yes |

Agent wants a new external test → opens a PR → human merges → then it runs with coverage credit. Lane 2 inherits the runner's auth (`storageState`), retry/flaky reporting, sharding, and fixtures — which is why AUTH-1 / FLAKE-1 / FLAKE-2 / SCALE-2 are no longer this project's problems.

---

## Release sequencing — two releases, ~16 weeks total (1 engineer)

`production-ready` is reached in **two steps**: v0.2 does what the docs say; v1.0 makes the gate tell the truth and enter CI.

### v0.2 — "does what it says" (~8 weeks)

Goal: the documented happy path works end-to-end, the foundation is clean, and it honestly serves the one niche it is good at — audit-grade sign-off of a ≤25-test, unauthenticated, critical-path browser flow.

**Phase 0 — Ship blockers (2 days). Do first: makes CI able to detect a broken product.**
- **D1** `src/cli/program.ts:44` emit `artifactDirectory` (not `resultsDirectory`); fix `README.md:38`; test round-trips `runCli(["init"])` through `loadQaConfig`. Either honour `artifactDirectory` in `RunWorkspace.create` or drop it from the schema.
- **D2** copy `shared/templates/` into `dist/` in `build` (or inline as TS constants); add `shared` to `package.json#files`; extend `smoke:package` to actually **render** a report from the installed tarball.
- **D3** map `WorkflowResult.outcome` **and** the registered gate `recommendation` to exit codes (`ExitCode.UNMET_OBLIGATIONS`/`BLOCKED` already exist). `workflow run` must stop exiting 0 on `NOT_READY`/`AWAITING_RUNTIME`.
- **D10 (diagnostics half)** interpolate `validateArtifact(...).errors` into the thrown message at all 6 ingestion sites; name the offending file in `cli/workflow.ts`. Highest single usability return.
- **D4** special-case `commander.help`/`helpDisplayed` → exit 0; add `.description()` to every command/option; drop the duplicate stderr write.

**Phase 1 — Characterization tests (3–5 days). Do before touching the god module.**
- Table-drive a spec for **every** artifact type asserting the write path (`assertSemanticReferences`) and the read path (`assertPersistedPlanningSemantics`) produce the **same** result — they have already drifted.
- Gate negatives (D9 targets, currently unlocked): malformed required critical obligation → `NOT_READY`; `TRIAGED` bug without `severity` → `NOT_READY`; `cleanup-run` with non-array `resources` → `NOT_READY`. Cover all 6 rules and both silent-drop paths.
- Safety: dropping the optional `environment` field must **fail** a test (today it silently disarms authorization).
- Golden snapshot of `inspectWorkspaceState` output.
- Add `@vitest/coverage-v8` with thresholds. Fix flaky `windows-paths.test.ts` (D40).

**Phase 2 — Tier 2 structural (3 weeks). Now safe under the net above.**
- Lift `assertSemanticReferences` + `assertPersistedPlanningSemantics` into one `Record<ArtifactType, SemanticRule>` consumed by both paths (kills ~313 lines, 7 layering inversions, and the write/read drift risk in one move).
- Extract `inspectWorkspaceState` (447 lines) out of `run-workspace.ts`.
- Relocate `orchestration/modes.ts` to the foundation tier; move `activeBrowserSessions` into `src/browser/session-registry.ts` (use the existing `getActiveBrowserSession()` accessor); cut the `run-workspace ↔ change-scope` type cycle.
- Add `import/no-cycle` and a layer-boundary lint to CI.
- Consolidate the 4 divergent canonical-JSON impls into one `src/core/values.ts#canonicalJson` with a documented `undefined` policy; unify the 13 object guards; introduce a closed `QaErrorCode` union and convert the 93 bare `throw new Error` sites (safety-class ones first → exit 4 not 5).

**Phase 3 — Lane-1 safety + honest surface (2 weeks).**
- **D5/D6** constrain `upload.files` to a runtime-owned root via `assertRealpathWithin`; constrain `open` to the profile origin with a scheme allowlist + resolved-IP check (reject loopback/link-local/RFC1918/169.254.169.254). Force `upload` steps to non-`none` side effect. One shared `assertNavigable` used by both the DSL path and exploration.
- **D7 dissolves:** exploratory moves to the **agent lane** — remove `executeExploration` + the `page.goto` loop, delete `src/exploratory/findings.ts`. Exploration runs through an **Agent Browser Adapter**; findings are `agent-draft` and never credit coverage (matches CONTEXT.md).
- **Trace opt-in (ADR-0009 extension):** default = do not retain trace; retain only when the Environment Profile permits **and** no secret resolved **and** no redaction target declared. Any declared `domSelectors`/`regions` forces `protectedEnvironment`. Remove the un-overridable hardcoded `trace:"on-failure"` in the safety layer. Refusal → Evidence Gap. Document traces in the README redaction section.
- **D12** gate annotation labels on `protectedEnvironment`; treat declared redaction targets as an implicit protection request.

**Phase 4 — Multi-agent shims (ADR-0011) + authoring UX (1 week).**
- Generate `AGENTS.md` (Codex) and `.cursor/rules/qa-skills.mdc` (Cursor) pointing at the copied skills; delete the blocking assert at `tests/skills/bundle.test.ts:28`; make `skills verify` check the shims.
- Ship `skills/shared/references/artifact-authoring.md` (a complete minimal valid example of each of the 4 agent-authored artifacts + the literal `dist/shared/schemas/<type>.schema.json` path + which fields are runtime-derived). Add `qa-skill schema show --type`, `qa-skill draft init --type`, `qa-skill fingerprint --file`.
- Add `skills/shared/references/recovery.md` (exit codes, `AWAITING_RUNTIME`, live lock, Evidence Gap, the "check `outcome`/`validation.valid` before reporting" imperative). Fix the literal `SOURCE_RUN_ID` placeholder in `qa-tester/SKILL.md`; stop labelling full-workflow examples "standalone".
- **D14 one-liner:** bound the `Promise.all` fan-out at `run-workspace.ts:343` to 8–32; hoist the `mediaType` check above the `sha256` call.

**v0.2 exit criteria:** a cold-start agent, given only the bundle + CLI, completes a full lane-1 run to a `READY`/`NOT_READY` gate; CI catches D1/D2-class breakage; no self-certifying trace channel; three agents genuinely discover the skill.

### v1.0 — "the gate tells the truth, and enters CI" (~8 weeks)

**Phase 5 — Schema evolution (2 weeks). One change per place, thanks to Phase 2.**
- Add `runtime-observed` to the provenance enum; permit it at the coverage-credit filter sites. Note for
  whoever implements this after the batch shape lands (Task 29): that is **4** sites, not 2 — the batch
  is a second shape flattened alongside per-attempt results, so each reader gates it separately
  (`release-gate.ts:113`, `release-gate.ts:117`, `evaluate-workspace-coverage.ts:80`,
  `evaluate-workspace-coverage.ts:89`).
- `test-result` → **batch shape**: one artifact per **Runtime-Observed Execution** holding many entries; evidence attached only for failing cases. Rework the `.find()`-per-attempt scans into `Map` indices.
- `evidence.schema.json` → `subject` union (`attempt` | `observed-execution`); `provenance` → discriminated union by `kind` (geometry required only for `screenshot`/`annotation`). Fixes the pre-existing "log evidence must declare dpr/scroll" wart. Bump `schemaVersion`.

**Phase 6 — Coverage model integrity (2 weeks).**
- `coverage-obligation` → add `executionSurface` (`browser|api|unit|integration|performance|security|manual`); `browser`+`viewport` required only when `surface=browser`. Bump to `2.0.0`. Uncovered surfaces become **authorable → explicitly unmet** in the gate (closes the CONTEXT.md:443-445 promise). *As shipped this is `3.0.0`: the `accessibilityMethod` enum below is a second, independent break on the same schema.*
- `test-result` → add `observedEngine`; coverage matches the **observed** engine, never the declared label (closes the CONTEXT.md:441-442 promise; the "XB-1" report this line used to cite does not exist in this repo or its history).
- `accessibilityMethod` → enum; automated methods require a machine artifact, manual methods require a **Human Attestation**, never inferred (kills A11Y-1).

**Phase 7 — Lane 2 (2 weeks).**
- `qa-skill execute playwright -- <args>`: runtime spawns the runner, captures exit + JSON reporter, records `runtime-observed` + `commitSha` + `specTreeSha256`. Dirty spec tree → REFUSED or `agent-draft`. Register one batched `test-result` + the raw reporter JSON as evidence (checksummed).
- ~~**Two prerequisites, both blocking, both inherited from Phase 6.**~~ **Both landed in `test-result-batch` 3.0.0, before any producer exists — which was the point.** A producer landing first would have turned each from a latent wart into a live mis-credit site. They were stated here rather than only in TSDoc on `release-gate.ts` / `evaluate-workspace-coverage.ts` because this bullet is the contract the next phase executes against, and those files need never be opened to write a producer. What the producer must now emit:
  1. **The attempt's Execution Surface is read, not hardcoded.** Each entry declares its own `executionSurface` (required; the `coverage-obligation` enum), and both readers read it with no fallback — the fail-OPEN one drops an entry that names none, the fail-CLOSED one rejects it. A producer must stamp the surface the suite actually ran on; a `unit` entry can no longer credit a browser obligation.
  2. **The viewport is observed, not inherited from the plan.** Each browser entry declares its own `viewport` (required on `browser`, forbidden elsewhere, as is `observedEngine`), and both readers compare that value rather than `test-case.coverage.viewport`. A producer must report the geometry the runner actually rendered at; an entry can no longer credit a geometry nothing rendered at. Lane 1 still derives its viewport from the declaration, correctly — `createBrowserAttemptSession` SETS the live context from it and the DSL has no resize action.
- Also lift the **human checkpoint** for `qa-skill attestation record` here (see `skills/shared/references/recovery.md`). Phase 6 shipped the artifact, the producer, and the credit path, but no run position where a person can record an attestation between the obligation being registered and the gate being snapshotted — so a `required` manual Accessibility Obligation is unsatisfiable today. Needs a workflow pause after `ingest-coverage-obligation` and before `generate-qa-report`, resumable by run id.

**Phase 8 — CI export + filters (1 week).**
- JUnit XML + SARIF projections from the canonical gate; a GitHub Actions example in the README consuming them.
- `retest`/`regression` become **filters** over both lanes (retest = the failing bug's tests; regression = change-scope-selected tests); `scaffoldWorkflowInput` emits `charter`/`retest`/`changeScope` so all six modes are CLI-reachable (fixes MODE-1).

**v1.0 exit criteria:** an external Playwright suite runs under `runtime-observed` and credits coverage; the gate models API/perf/security/manual/a11y obligations honestly; a CI pipeline fails on `NOT_READY` and reads JUnit/SARIF.

---

## Explicitly out of scope

- QA Skills re-implementing auth, flake management, sharding, or a broader browser DSL — delegated to lane 2's runner (ADR-0010).
- Visual regression, native mobile, real-device — modelled as authorable-but-unmet obligations, not executed.
- Jira/TestRail sync — an `externalReferences` extension point on schemas is deferred to post-v1.0.

## Risk register

- **Tier 2 mid-flight abandonment** (the shape most likely to be cut). Mitigated by: Phase 0 ships value in 2 days; Phase 1 net makes the refactor verifiable; v0.2 gives Tier 2 a near delivery milestone to survive to.
- **A design assumption is wrong** (git anchor vs real workflow; batch sufficiency for audit; lane 2 fit). Mitigated by shipping v0.2 for dogfooding before the 8-week v1.0 investment.
- **Characterization gaps** — if Phase 1 under-specifies, Phase 2 refactors blind. Treat Phase 1 coverage of the two rule chains and the gate as a hard gate on starting Phase 2.
