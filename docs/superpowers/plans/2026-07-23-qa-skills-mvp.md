# QA Skills MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete browser-focused QA Skills MVP with portable agent skills, deterministic TypeScript runtime, validated artifacts, Playwright evidence, reports, and an expected-failure demo.

**Architecture:** Coding agents author provenance-marked drafts; a provider-independent TypeScript runtime validates and canonicalizes them, executes typed operations, and stores immutable artifacts in a manifest-authoritative Run Workspace. Browser execution uses a bounded Test DSL and Playwright, while evidence, coverage, defect classification, and release recommendations remain typed and auditable.

**Tech Stack:** Node.js 22+, npm, strict ESM TypeScript, Vitest, Playwright, AJV, JSON Schema Draft 2020-12, `yaml`, `sharp`, `commander`, `ulid`.

## Global Constraints

- Package name: `@vigentix/qa-skills`; CLI binary: `qa-skill`; orchestrator skill: `qa-tester`.
- Node engine is `>=22`; source is strict ESM TypeScript; npm lockfile is committed.
- JSON Schema Draft 2020-12 files under `shared/schemas/` are the source of truth; canonical run artifacts are JSON; Markdown is derived.
- Runtime embeds no LLM and never silently repairs invalid agent output.
- Terminal runs and completed artifacts are immutable; retest, regression, and cleanup retries create linked runs.
- Machine timestamps are UTC. Run IDs match `YYYYMMDDTHHmmssZ-<6 lowercase hex chars>`; attempts and evidence use ULIDs.
- Browser runtime executes only the bounded Test DSL; no XPath and no arbitrary JavaScript evaluation in the MVP.
- Every browser Test Attempt gets a fresh BrowserContext; attempts execute sequentially; whole-test reruns are explicit attempts.
- Statuses are `PASSED | FAILED | BLOCKED | INCONCLUSIVE | NOT_RUN`; classifications are `PRODUCT_DEFECT | TEST_DEFECT | ENVIRONMENT_DEFECT | UNDETERMINED | NONE`.
- Only `FAILED + PRODUCT_DEFECT` creates a Bug Candidate.
- Production is denied by default and, when explicitly enabled, allows only `sideEffect: none`; no production seed/cleanup.
- Secrets remain unresolved references in artifacts and are scrubbed before persistence.
- Protected evidence is redacted before persistence; unsafe capture produces an Evidence Gap.
- Release recommendation is deterministic: `READY | READY_WITH_RISKS | NOT_READY`.
- Code, schemas, enums, skills, and canonical examples use English; JSON is never localized; Markdown projections support `en | vi`.
- All production behavior is developed test-first with observed RED and GREEN evidence in the implementer report.

---

### Task 1: Project Toolchain and Contract Foundation

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `eslint.config.js`
- Create: `src/contracts/types.ts`
- Create: `src/contracts/catalog.ts`
- Create: `src/contracts/validator.ts`
- Create: `src/contracts/authoring.ts`
- Create: `src/core/errors.ts`
- Create: `src/core/ids.ts`
- Create: `src/core/time.ts`
- Create: `scripts/generate-types.ts`
- Create: `shared/schemas/run-metadata.schema.json`
- Create: `shared/schemas/artifact-manifest.schema.json`
- Create: `shared/schemas/environment-profile.schema.json`
- Create: `shared/schemas/test-case.schema.json`
- Create: `shared/schemas/test-step-result.schema.json`
- Create: `shared/schemas/test-result.schema.json`
- Create: `shared/schemas/evidence.schema.json`
- Create: `shared/schemas/bug-report.schema.json`
- Create: `shared/schemas/test-data-manifest.schema.json`
- Create: `shared/schemas/qa-execution-report.schema.json`
- Test: `tests/contracts/validator.test.ts`
- Test: `tests/core/ids.test.ts`
- Test: `tests/contracts/authoring.test.ts`

**Interfaces:**
- Produces: `ArtifactType`, `ArtifactEnvelope<T>`, `RunStatus`, `ExecutionStatus`, `FailureClassification`, `SideEffectClass` from `src/contracts/types.ts`.
- Produces: `validateArtifact(type: ArtifactType, value: unknown): ValidationResult` from `src/contracts/validator.ts`.
- Produces: `parseAuthoringDocument(source: string, format: "json" | "yaml"): unknown` from `src/contracts/authoring.ts`.
- Produces: `createRunId(now?: Date): string`, `createEntityId(now?: number): string` from `src/core/ids.ts`.
- Produces: `utcNow(clock?: () => Date): string` from `src/core/time.ts`.

- [ ] **Step 1: Write failing contract, authoring, and ID tests**

Create tests that import the interfaces above and assert:

```ts
expect(createRunId(new Date("2026-07-23T12:34:56Z"))).toMatch(
  /^20260723T123456Z-[0-9a-f]{6}$/,
);
expect(createEntityId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
expect(parseAuthoringDocument("mode: full", "yaml")).toEqual({ mode: "full" });
expect(validateArtifact("run-metadata", validRun).valid).toBe(true);
expect(validateArtifact("run-metadata", { ...validRun, status: "PASS" }).valid).toBe(false);
```

- [ ] **Step 2: Run focused tests and capture RED**

Run: `npm test -- tests/contracts/validator.test.ts tests/contracts/authoring.test.ts tests/core/ids.test.ts`

Expected: failure because the package and imported modules do not exist.

- [ ] **Step 3: Add the strict Node/TypeScript toolchain**

Configure scripts:

```json
{
  "build": "tsc -p tsconfig.json",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "lint": "eslint .",
  "test": "vitest run",
  "test:watch": "vitest",
  "generate:types": "tsx scripts/generate-types.ts",
  "check:generated": "npm run generate:types && git diff --exit-code -- src/contracts/generated"
}
```

Use runtime dependencies `ajv`, `ajv-formats`, `commander`, `sharp`, `ulid`, `yaml`, and dev dependencies `@playwright/test`, `@types/node`, `eslint`, `json-schema-to-typescript`, `tsx`, `typescript`, `typescript-eslint`, `vitest`.

- [ ] **Step 4: Implement canonical schemas and validation**

Every schema must declare Draft 2020-12, `$id`, `title`, `type`, required fields, `additionalProperties: false`, and semantic version `1.0.0` through the envelope. Implement the exact enums from Global Constraints. Compile schemas once in the catalog and return normalized AJV errors without mutating input.

- [ ] **Step 5: Implement YAML/JSON parsing, IDs, UTC time, and generated types**

Reject non-object authoring roots and YAML multi-document input. Use cryptographic randomness for run suffixes and `ulid` for entity IDs. Generate one TypeScript declaration per schema into `src/contracts/generated/`.

- [ ] **Step 6: Run GREEN and full foundation verification**

Run:

```bash
npm run generate:types
npm test -- tests/contracts/validator.test.ts tests/contracts/authoring.test.ts tests/core/ids.test.ts
npm run typecheck
npm run lint
```

Expected: all commands exit `0` with no warnings.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts eslint.config.js src scripts shared tests
git commit -m "feat: establish QA artifact contracts"
```

### Task 2: Run Workspace, Lifecycle, Artifact Profiles, and CLI Core

**Files:**
- Create: `src/core/fs.ts`
- Create: `src/core/checksum.ts`
- Create: `src/core/run-workspace.ts`
- Create: `src/core/run-lock.ts`
- Create: `src/core/artifact-profiles.ts`
- Create: `src/operations/create-run.ts`
- Create: `src/operations/ingest-artifact.ts`
- Create: `src/operations/validate-run.ts`
- Create: `src/cli/exit-codes.ts`
- Create: `src/cli/program.ts`
- Create: `src/cli/index.ts`
- Create: `scripts/create-run.ts`
- Create: `scripts/validate-artifacts.ts`
- Test: `tests/core/run-workspace.test.ts`
- Test: `tests/core/run-lock.test.ts`
- Test: `tests/core/artifact-profiles.test.ts`
- Test: `tests/cli/core.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts, IDs, validation, and time helpers.
- Produces: `RunWorkspace.create(options)`, `RunWorkspace.open(root, runId)`, `registerArtifact(input)`, `transition(status)`, `finalize(profile)`.
- Produces: `ArtifactProfileName = "plan" | "execute" | "full" | "exploratory" | "retest" | "regression" | "cleanup"`.
- Produces CLI commands `init`, `artifact ingest`, `validate`, and `skills list`.

- [ ] **Step 1: Write failing workspace and CLI tests**

Tests must prove:

```ts
const workspace = await RunWorkspace.create({ root, mode: "plan", environmentProfile });
const registered = await workspace.registerArtifact({
  type: "run-metadata",
  sourcePath,
  relationships: [],
});
expect(registered.relativePath.startsWith("inputs/")).toBe(true);
expect(await sha256(registered.absolutePath)).toBe(registered.sha256);
await expect(workspace.registerArtifact(sameInput)).rejects.toThrow(/immutable|duplicate/i);
```

Also assert path traversal rejection, stale-lock resume, live-lock refusal, legal/illegal lifecycle transitions, mode-specific required artifacts, orphan detection, missing files, checksum mismatch, and exact CLI exit codes `0..5`.

- [ ] **Step 2: Run focused tests and capture RED**

Run: `npm test -- tests/core/run-workspace.test.ts tests/core/run-lock.test.ts tests/core/artifact-profiles.test.ts tests/cli/core.test.ts`

Expected: imports fail because Task 2 modules do not exist.

- [ ] **Step 3: Implement secure filesystem and manifest registration**

Use atomic temp-file-plus-rename writes. Resolve every path beneath the run root and reject traversal/symlink escapes. Store relative paths only. Create artifact directories lazily. Never scan for “latest” files.

- [ ] **Step 4: Implement lifecycle, locks, and profiles**

Implement `CREATED -> RUNNING -> FINALIZING -> terminal`. Terminal workspaces reject writes. Resume only non-terminal runs with no live lock. Profiles distinguish structurally valid Evidence Gaps from unregistered missing files.

- [ ] **Step 5: Implement CLI core and standalone scripts**

Use `commander`. `init` writes `qa.config.yaml` and safely updates `.gitignore` without overwriting. `artifact ingest` validates and registers an Agent Draft. `validate` emits machine-readable diagnostics. `skills list` reports execution kind.

- [ ] **Step 6: Run GREEN and full verification**

Run:

```bash
npm test -- tests/core/run-workspace.test.ts tests/core/run-lock.test.ts tests/core/artifact-profiles.test.ts tests/cli/core.test.ts
npm test
npm run typecheck
npm run lint
```

Expected: all commands exit `0`, output pristine.

- [ ] **Step 7: Commit**

```bash
git add src scripts tests package.json package-lock.json
git commit -m "feat: add immutable QA run workspaces"
```

### Task 3: Requirement, Testcase, Coverage, and Approval Operations

**Files:**
- Create: `shared/schemas/requirement-analysis.schema.json`
- Create: `shared/schemas/coverage-obligation.schema.json`
- Create: `shared/schemas/test-plan.schema.json`
- Create: `src/planning/authority.ts`
- Create: `src/planning/testcase-revision.ts`
- Create: `src/planning/parameterization.ts`
- Create: `src/planning/coverage.ts`
- Create: `src/planning/approval.ts`
- Create: `src/operations/ingest-requirement-analysis.ts`
- Create: `src/operations/ingest-testcases.ts`
- Test: `tests/planning/authority.test.ts`
- Test: `tests/planning/revision.test.ts`
- Test: `tests/planning/parameterization.test.ts`
- Test: `tests/planning/coverage.test.ts`
- Test: `tests/planning/approval.test.ts`

**Interfaces:**
- Consumes: Task 1 validator and Task 2 Run Workspace ingestion.
- Produces: `classifyUserStatement(input): RequirementAuthority`.
- Produces: `createTestCaseRevision(candidate): TestCaseRevision`.
- Produces: `expandTestCase(revision, coverageProfile): TestCaseInstance[]`.
- Produces: `evaluateCoverage(obligations, attempts): CoverageEvaluation`.
- Produces: `evaluateApproval(candidate, policy, environment): ApprovalDecision`.

- [ ] **Step 1: Write failing planning tests**

Cover explicit expected behavior as authoritative, tentative wording as assumed, code behavior as inferred, authoritative conflicts as conflicting, deterministic testcase fingerprinting, parameter expansion, no duplicate logical cases, and obligation satisfaction only by authoritative passing attempts.

- [ ] **Step 2: Run focused tests and capture RED**

Run: `npm test -- tests/planning`

Expected: failure because planning modules do not exist.

- [ ] **Step 3: Add planning schemas and generated types**

Requirement statements include source provenance, normalized text, authority, role, rules, risks, assumptions, and open questions. Coverage obligations include requirement, role, behavior, browser, viewport, accessibility method, risk, required flag, and outcome.

- [ ] **Step 4: Implement revisions, instances, coverage, and approval**

Use canonical JSON serialization before SHA-256 revision fingerprinting. Expand parameter sets and Browser Matrix without duplicating Test Case IDs. `auto-approve-safe` requires authoritative assertions, valid DSL, no relevant open questions, non-production target, and only `none`/cleanable `reversible` steps.

- [ ] **Step 5: Implement ingestion operations**

Ingest Agent Drafts without model calls. Preserve producer/provenance. Reject unsupported authority, unsafe auto-approval, and orphan expected results.

- [ ] **Step 6: Run GREEN and full verification**

Run:

```bash
npm run generate:types
npm test -- tests/planning
npm test
npm run typecheck
```

Expected: all pass without warnings.

- [ ] **Step 7: Commit**

```bash
git add shared src tests
git commit -m "feat: add requirement and testcase planning"
```

### Task 4: Browser Test DSL and Playwright Executor

**Files:**
- Create: `shared/schemas/browser-test-dsl.schema.json`
- Create: `src/browser/types.ts`
- Create: `src/browser/locator.ts`
- Create: `src/browser/assertions.ts`
- Create: `src/browser/playwright/session.ts`
- Create: `src/browser/playwright/executor.ts`
- Create: `src/browser/playwright/telemetry.ts`
- Create: `src/operations/execute-browser-test.ts`
- Test: `tests/browser/locator.test.ts`
- Test: `tests/browser/aggregation.test.ts`
- Test: `tests/browser/executor.integration.test.ts`
- Create: `fixtures/browser/basic.html`
- Create: `fixtures/browser/server.ts`

**Interfaces:**
- Consumes: approved Test Case Instances from Task 3 and Run Workspace from Task 2.
- Produces: `executeTestInstance(input: ExecuteTestInput): Promise<TestAttempt>`.
- Produces: `resolveLocator(page, definition): Locator`.
- Produces: `aggregateStepResults(results): ExecutionStatus`.
- Produces active browser session registry for Task 5 evidence attachment.

- [ ] **Step 1: Write failing DSL, locator, aggregation, and integration tests**

Assert locator priority, unsupported XPath/eval rejection, exact action/assertion list, fresh BrowserContext per attempt, sequential attempts, fail-fast behavior, safe `continueOnFailure`, status precedence, `NOT_RUN` dependent steps, and no hidden whole-test retry.

- [ ] **Step 2: Run focused tests and capture RED**

Run: `npm test -- tests/browser`

Expected: missing browser modules and failing integration imports.

- [ ] **Step 3: Implement the bounded DSL and locator resolver**

Actions: `open`, `click`, `fill`, `select`, `check`, `uncheck`, `press`, `upload`, `wait`. Assertions: visibility, text, value, URL, element count, enabled/disabled, checked, observed response status, console/network policy.

- [ ] **Step 4: Implement Playwright sessions, telemetry, and execution**

Reuse the browser process but create a fresh context/page per attempt. Resolve Secret References in memory through an injected resolver. Register telemetry listeners before steps. Classify normal navigation cancellations separately.

- [ ] **Step 5: Implement deterministic step and attempt outcomes**

Capture action/assertion details and timestamps. Stop at first failure unless later steps are explicitly independent and `sideEffect: none`. Never rewrite expected behavior or convert a later pass into replacement for an earlier failure.

- [ ] **Step 6: Run GREEN and full verification**

Run:

```bash
npx playwright install chromium
npm test -- tests/browser
npm test
npm run typecheck
```

Expected: unit and Chromium integration tests pass, output pristine.

- [ ] **Step 7: Commit**

```bash
git add shared src tests fixtures package.json package-lock.json
git commit -m "feat: execute browser testcase instances"
```

### Task 5: Evidence Capture, Redaction, Annotation, and Provenance

**Files:**
- Create: `shared/schemas/annotation.schema.json`
- Create: `src/evidence/policy.ts`
- Create: `src/evidence/redaction.ts`
- Create: `src/evidence/geometry.ts`
- Create: `src/evidence/annotator.ts`
- Create: `src/evidence/collector.ts`
- Create: `src/evidence/manifest.ts`
- Create: `src/operations/collect-evidence.ts`
- Create: `scripts/annotate-screenshot.ts`
- Test: `tests/evidence/policy.test.ts`
- Test: `tests/evidence/redaction.test.ts`
- Test: `tests/evidence/geometry.test.ts`
- Test: `tests/evidence/annotator.test.ts`
- Test: `tests/evidence/collector.integration.test.ts`

**Interfaces:**
- Consumes: active browser sessions and attempts from Task 4.
- Produces: `resolveEvidencePolicy(layers): ResolvedEvidencePolicy`.
- Produces: `normalizeGeometry(input): PixelAnnotation[]`.
- Produces: `annotateScreenshot(input): Promise<AnnotatedEvidence>`.
- Produces: `capture`, `attach`, and `annotate` evidence operations.

- [ ] **Step 1: Write failing policy, redaction, geometry, and annotation tests**

Assert precedence `safety > profile > run > testcase`, testcase cannot lower minimums, redaction occurs before persistence, unsafe redaction produces Evidence Gap, CSS-page-to-pixel conversion handles DPR/scroll/clip, invalid/out-of-bounds geometry is rejected, and the raw file checksum remains unchanged.

- [ ] **Step 2: Run focused tests and capture RED**

Run: `npm test -- tests/evidence`

Expected: failure because evidence modules do not exist.

- [ ] **Step 3: Implement policy and capture-time redaction**

Default logs always, console/network for live browser sessions, screenshot on failure, trace retain on failure, video off. Mask configured DOM selectors/regions before capture. Scrub exact secret values and sensitive headers/bodies before persistence.

- [ ] **Step 4: Implement geometry and Sharp SVG annotation**

Render bounding boxes, arrows, numbered markers, short labels, and metadata footer. Keep sanitized raw and annotated outputs separate. Store capture type, dimensions, DPR, scroll/clip origins, CSS boxes, normalized pixel boxes, locator, URL, viewport, browser, build, timestamp, testcase/attempt/bug IDs.

- [ ] **Step 5: Implement live collector and evidence manifest**

`capture` starts listeners before actions, `attach` requires an active session ID, and `annotate` accepts existing screenshot provenance. Closed-session telemetry requests create Evidence Gaps instead of reconstructed logs.

- [ ] **Step 6: Run GREEN and full verification**

Run:

```bash
npm test -- tests/evidence
npm test
npm run typecheck
```

Expected: all pass; generated PNG fixture assertions and checksums are stable.

- [ ] **Step 7: Commit**

```bash
git add shared src scripts tests
git commit -m "feat: capture auditable browser evidence"
```

### Task 6: Test Data Hooks, Environment Safety, and Cleanup Runs

**Files:**
- Create: `shared/schemas/qa-config.schema.json`
- Create: `shared/schemas/cleanup-run.schema.json`
- Create: `src/config/load-config.ts`
- Create: `src/config/secret-resolver.ts`
- Create: `src/safety/side-effects.ts`
- Create: `src/safety/external-permits.ts`
- Create: `src/test-data/hooks.ts`
- Create: `src/test-data/resources.ts`
- Create: `src/test-data/cleanup.ts`
- Create: `src/operations/prepare-test-data.ts`
- Create: `src/operations/cleanup-run.ts`
- Test: `tests/config/load-config.test.ts`
- Test: `tests/safety/policy.test.ts`
- Test: `tests/test-data/hooks.test.ts`
- Test: `tests/test-data/cleanup.test.ts`

**Interfaces:**
- Consumes: Run Workspace, Environment Profile, Test Case Instance side-effect declarations.
- Produces: `loadQaConfig(options): QaConfig`.
- Produces: `authorizeStep(step, environment, permits): SafetyDecision`.
- Produces: `TestDataHookRegistry`.
- Produces: `prepareTestData(input): Promise<TestDataManifest>`.
- Produces: `executeCleanupRun(input): Promise<CleanupRunResult>`.

- [ ] **Step 1: Write failing config, safety, hooks, and cleanup tests**

Cover config precedence, path resolution from config directory, no implicit multi-config merge, unresolved secrets preserved in snapshots, production default denial, read-only production opt-in, external permit scope/expiry/use limit, no real payment/destructive action, run resource ownership, reverse-order idempotent cleanup, and linked immutable Cleanup Runs.

- [ ] **Step 2: Run focused tests and capture RED**

Run: `npm test -- tests/config tests/safety tests/test-data`

Expected: missing modules.

- [ ] **Step 3: Implement declarative config and in-memory secrets**

Support explicit `--config`, nearest config to repo root, then safe defaults. Do not load executable TypeScript config. Resolve `${ENV:NAME}` only at operation time and scrub resolved values from logs.

- [ ] **Step 4: Implement safety policy and permits**

CLI flags cannot override environment classification or fabricate permits. Production permits only `none`. External effects require channel/action, environment, test target, max uses, expiry, and source. Deny wildcard recipients.

- [ ] **Step 5: Implement trusted hooks and cleanup runs**

Hooks are pre-registered command/args arrays, API fixtures, or module paths; testcase input names hook ID only. Store explicit resource IDs and ownership. A cleanup retry creates a new linked run and never mutates/deletes source artifacts.

- [ ] **Step 6: Run GREEN and full verification**

Run:

```bash
npm run generate:types
npm test -- tests/config tests/safety tests/test-data
npm test
npm run typecheck
```

Expected: all pass without environment-secret leakage in output.

- [ ] **Step 7: Commit**

```bash
git add shared src tests
git commit -m "feat: manage safe traceable test data"
```

### Task 7: Defects, Incidents, Coverage Reports, and Release Gates

**Files:**
- Create: `shared/schemas/incident.schema.json`
- Create: `shared/schemas/release-gate.schema.json`
- Create: `src/defects/eligibility.ts`
- Create: `src/defects/reproduction.ts`
- Create: `src/defects/fingerprint.ts`
- Create: `src/defects/triage.ts`
- Create: `src/defects/incidents.ts`
- Create: `src/reporting/release-gate.ts`
- Create: `src/reporting/report-model.ts`
- Create: `src/reporting/render-json.ts`
- Create: `src/reporting/render-markdown.ts`
- Create: `shared/templates/report.en.md`
- Create: `shared/templates/report.vi.md`
- Create: `src/operations/generate-bug-report.ts`
- Create: `src/operations/generate-qa-report.ts`
- Create: `scripts/generate-report.ts`
- Test: `tests/defects/eligibility.test.ts`
- Test: `tests/defects/reproduction.test.ts`
- Test: `tests/defects/fingerprint.test.ts`
- Test: `tests/defects/triage.test.ts`
- Test: `tests/reporting/release-gate.test.ts`
- Test: `tests/reporting/render.test.ts`

**Interfaces:**
- Consumes: attempts, evidence, coverage evaluations, resources, and incidents.
- Produces: `createBugCandidate(attempt): BugCandidate | null`.
- Produces: `evaluateReproduction(attempts): ReproductionResult`.
- Produces: `createBugFingerprint(input): string`.
- Produces: `evaluateReleaseGate(input): ReleaseGateResult`.
- Produces: canonical JSON report and localized Markdown projection.

- [ ] **Step 1: Write failing defect, incident, gate, and rendering tests**

Assert only eligible product failures create candidates; normal reproduction uses two total attempts; unsafe rerun omission; `2/2`, `1/2`, and intermittent outcomes; run-suffixed bug IDs; within-run consolidation and cross-run possible duplicate; `NEEDS_TRIAGE` has no severity; `TRIAGED` uses five exact severities; test/environment/unknown create their typed artifacts.

- [ ] **Step 2: Run focused tests and capture RED**

Run: `npm test -- tests/defects tests/reporting`

Expected: missing modules.

- [ ] **Step 3: Implement defect and incident operations**

Separate severity from priority recommendation and Test Priority. Preserve expected/actual, environment, reproduction set, evidence references, affected areas, open questions, and provenance. Never infer a product root cause for undetermined findings.

- [ ] **Step 4: Implement deterministic release gates**

`NOT_READY`: open Blocker/Critical, untriaged product bug, required high-risk case not passing, required coverage missing, invalid artifacts, or shared blocker. `READY_WITH_RISKS`: required high-risk obligations pass with no Blocker/Critical but optional gaps or non-critical defects remain. `READY`: all required obligations pass and no open product defect remains. Preserve rule inputs/verdicts.

- [ ] **Step 5: Implement canonical report and en/vi projections**

JSON remains English. Markdown localizes headings/labels only. Include build, summary, coverage methods, incidents, bugs, telemetry findings, Evidence Gaps, cleanup leaks, critical findings, remaining risks, excluded/not-run items, and release recommendation.

- [ ] **Step 6: Run GREEN and full verification**

Run:

```bash
npm run generate:types
npm test -- tests/defects tests/reporting
npm test
npm run typecheck
```

Expected: all pass; Markdown golden outputs stable.

- [ ] **Step 7: Commit**

```bash
git add shared src scripts tests
git commit -m "feat: generate defect and QA reports"
```

### Task 8: Orchestration Modes, Retest, Regression, and Exploratory Testing

**Files:**
- Create: `shared/schemas/exploration-charter.schema.json`
- Create: `shared/schemas/retest-result.schema.json`
- Create: `shared/schemas/regression-selection.schema.json`
- Create: `src/orchestration/modes.ts`
- Create: `src/orchestration/qa-tester.ts`
- Create: `src/exploratory/charter.ts`
- Create: `src/exploratory/findings.ts`
- Create: `src/retest/verdict.ts`
- Create: `src/regression/change-scope.ts`
- Create: `src/regression/selector.ts`
- Create: `src/operations/run-workflow.ts`
- Test: `tests/orchestration/modes.test.ts`
- Test: `tests/exploratory/charter.test.ts`
- Test: `tests/retest/verdict.test.ts`
- Test: `tests/regression/selector.test.ts`

**Interfaces:**
- Consumes: all prior typed operations.
- Produces: `runWorkflow(input): Promise<WorkflowResult>` for `plan`, `execute`, `full`, `exploratory`, `retest`, `regression`.
- Produces: Retest verdicts `FIXED | NOT_FIXED | PARTIALLY_FIXED | CANNOT_VERIFY | INTERMITTENT`.
- Produces: regression selections with source, reason, confidence, exclusions, and Unmapped Change Risks.

- [ ] **Step 1: Write failing orchestration and mode tests**

Test exact operation order per mode, no unnecessary full pipeline, full-mode safe approval, exact-reproduction-before-regression, independent retest verdict/regression outcome, charter budgets/stop conditions, exploratory findings not satisfying coverage, and selector source priority.

- [ ] **Step 2: Run focused tests and capture RED**

Run: `npm test -- tests/orchestration tests/exploratory tests/retest tests/regression`

Expected: missing modules.

- [ ] **Step 3: Implement mode orchestration**

Use operation dependency metadata rather than skill-to-skill shelling. `execute` accepts approved revisions, `full` composes planning through report, `retest` creates linked run and preserves bug identity, and `cleanup` remains CLI maintenance mode rather than a public qa-tester mode.

- [ ] **Step 4: Implement exploratory and retest semantics**

Exploration requires mission, scope, roles, heuristics, safety rules, action/time budget, and stop conditions. Unexpected non-authoritative behavior becomes a finding/candidate. Retest verdict evaluates the original bug independently from related regression.

- [ ] **Step 5: Implement explainable regression selection**

Priority: requirement mapping, code-surface mapping, declared dependencies, git diff heuristics, user scope. Every selected/excluded case gets rationale and confidence. Unmapped changes prevent complete-regression claims.

- [ ] **Step 6: Run GREEN and full verification**

Run:

```bash
npm run generate:types
npm test -- tests/orchestration tests/exploratory tests/retest tests/regression
npm test
npm run typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add shared src tests
git commit -m "feat: orchestrate QA workflow modes"
```

### Task 9: Portable Skill Bundle and Non-Destructive Installer

**Files:**
- Create: `skills/qa-tester/SKILL.md`
- Create: `skills/requirement-analyzer/SKILL.md`
- Create: `skills/testcase-designer/SKILL.md`
- Create: `skills/test-data-manager/SKILL.md`
- Create: `skills/browser-test-executor/SKILL.md`
- Create: `skills/evidence-collector/SKILL.md`
- Create: `skills/bug-reporter/SKILL.md`
- Create: `skills/qa-report-generator/SKILL.md`
- Create: `skills/shared/references/artifact-contracts.md`
- Create: `skills/shared/references/agent-browser-adapters.md`
- Create: `skills/shared/references/safety.md`
- Create: `src/installer/agents.ts`
- Create: `src/installer/manifest.ts`
- Create: `src/installer/install.ts`
- Create: `src/installer/update.ts`
- Create: `src/installer/verify.ts`
- Create: `src/installer/uninstall.ts`
- Test: `tests/skills/bundle.test.ts`
- Test: `tests/installer/lifecycle.test.ts`
- Test: `tests/installer/windows-paths.test.ts`

**Interfaces:**
- Consumes: CLI and runtime version from prior tasks.
- Produces: install/update/verify/uninstall commands for `codex | claude | cursor` and `project | user`.
- Produces install manifest with source version, compatible runtime range, target, and per-file checksums.

- [ ] **Step 1: Write failing skill and installer tests**

Assert all eight skills have matching lowercase-hyphen folder/name, precise description, execution kind, runtime resolution rules, shared safety rules, standalone/full examples, and no vendor-duplicated SKILL definitions. Installer tests cover clean install, drift, update refusal, force backup, safe uninstall leftovers, project/user roots, Windows separators, and no remote `npx` fallback.

- [ ] **Step 2: Run focused tests and capture RED**

Run: `npm test -- tests/skills tests/installer`

Expected: missing skills and installer modules.

- [ ] **Step 3: Author the canonical portable Skill Bundle**

Use only standard `name` and `description` frontmatter. Keep skills concise and progressively disclose shared contracts/safety/agent-browser guidance. Agent-authored skills instruct draft creation plus `artifact ingest`; runtime-backed skills invoke the local compatible runtime.

- [ ] **Step 4: Implement copy-based installer lifecycle**

Resolve exact target paths before writes. Never use symlinks. Update/uninstall only unchanged tracked files. Report `missing | modified | unexpected | valid`. `--force` creates a recoverable backup. Do not remove directories containing untracked files.

- [ ] **Step 5: Wire CLI commands and runtime compatibility checks**

Resolution order is project `node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`, otherwise fail with setup guidance. Never invoke remote `npx --yes`.

- [ ] **Step 6: Run GREEN and full verification**

Run:

```bash
npm test -- tests/skills tests/installer
npm test
npm run typecheck
```

Expected: all pass on POSIX with Windows path semantics covered by pure tests.

- [ ] **Step 7: Commit**

```bash
git add skills src tests package.json
git commit -m "feat: distribute portable QA agent skills"
```

### Task 10: End-to-End Demo, Documentation, Governance, and CI

**Files:**
- Create: `fixtures/demo/server.ts`
- Create: `fixtures/demo/index.html`
- Create: `fixtures/demo/demo-testcase.yaml`
- Create: `fixtures/demo/demo-config.yaml`
- Create: `scripts/run-demo.ts`
- Create: `tests/e2e/demo.test.ts`
- Create: `examples/sample-testcase.yaml`
- Create: `examples/sample-result.json`
- Create: `examples/sample-bug-report.md`
- Create: `examples/sample-qa-report.md`
- Create: `README.md`
- Create: `docs/README.vi.md`
- Create: `LICENSE`
- Create: `NOTICE`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `.github/workflows/ci.yml`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Consumes: complete runtime, operations, CLI, skills, and installer.
- Produces: `npm run demo`, which exits `0` only when the intentional defect is correctly detected and all expected artifacts validate.
- Produces: public setup/usage documentation for Codex, Claude Code, and Cursor.

- [ ] **Step 1: Write failing end-to-end demo test**

The fixture must omit an authoritative validation message, emit a deterministic console error, and call a deterministic failing local request. The test asserts:

```ts
expect(run.status).toBe("COMPLETED_WITH_FAILURES");
expect(attempt.status).toBe("FAILED");
expect(attempt.classification).toBe("PRODUCT_DEFECT");
expect(files).toContainEqual(expect.stringMatching(/screenshots\\/raw\\/.*\\.png$/));
expect(files).toContainEqual(expect.stringMatching(/screenshots\\/annotated\\/.*\\.png$/));
expect(report.releaseRecommendation).toBe("NOT_READY");
expect(validation.valid).toBe(true);
```

- [ ] **Step 2: Run demo test and capture RED**

Run: `npm test -- tests/e2e/demo.test.ts`

Expected: failure because the fixture and demo harness do not exist.

- [ ] **Step 3: Implement deterministic localhost demo**

Start on an ephemeral localhost port, run Chromium desktop and emulated mobile Test Case Instances, capture failure evidence/trace/telemetry, create a Bug Candidate/report, render QA report, validate the Full Artifact Profile, stop the server, and clean owned test resources. No external network calls.

- [ ] **Step 4: Add sanitized examples and complete documentation**

Document install, init, config, all CLI commands/exit codes, full and standalone skill use, browser binaries, environment safety, evidence/redaction, artifact layout, troubleshooting, and agent-specific installation. English is canonical; Vietnamese quickstart is complete enough to execute the demo.

- [ ] **Step 5: Add Apache-2.0 governance and CI**

CI:

- Ubuntu Node 22/24: install, generate drift, typecheck, lint, unit/schema/CLI.
- Windows Node 24: unit, paths, init and installer lifecycle.
- Ubuntu Node 24: install Chromium, browser integration, expected-failure demo.
- Secret scan uses a deterministic repository pattern check and ensures `qa-results/` is ignored.

- [ ] **Step 6: Run complete GREEN verification**

Run:

```bash
npm ci
npm run generate:types
npm run check:generated
npm run typecheck
npm run lint
npm test
npm run demo
npm run build
```

Expected: every command exits `0`, output pristine; demo itself contains a schema-valid `COMPLETED_WITH_FAILURES` QA Run.

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat: complete QA Skills MVP"
```
