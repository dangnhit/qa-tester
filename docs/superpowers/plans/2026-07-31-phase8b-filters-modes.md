# Phase 8b — filters over both lanes, and six reachable modes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One regression/retest selection filters both lanes — lane 2 (`qa-skill execute playwright`) is verified against it and lane 1 drives only what lane 2 did not cover — and all six public workflow modes become reachable through `qa-skill workflow run`.

**Architecture:** A new non-terminal outcome `AWAITING_OBSERVED_EXECUTION` pauses the run in front of `execute-browser-test` exactly where `AWAITING_HUMAN_INPUT` already pauses, so the operator can run the observed suite against the paused run and resume. On resume, the residual (selected cases minus observed triples) is driven, and three guards that today demand "driven == selected" become the same union-coverage question. Separately, the CLI gains the wiring and scaffold inputs the three unreachable modes need.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest, Commander, Playwright (test fixtures only), `ajv` — all already present.

Spec: `docs/superpowers/specs/2026-07-31-phase8b-filters-modes-design.md`. Baseline: `main` @ `3565780`.
Branch: `feat/phase8b-filters-modes` off that commit (project convention: branch + FF-merge, as phases 3–8a did).

## Global Constraints

- **TDD, always.** Write the test, RUN it, paste the real failure into the task report, then implement. A test written after the code is not evidence.
- **Every test proven by mutation before it is accepted:** delete or invert the line it covers, watch it go red, restore. Report each mutation and its observed failure message. A test that passes with the feature removed is not a test.
- **Assert consequence, not rejection.** For the pause tests, that means the registered artifact set and the run's persisted status — not only that a promise resolved with an outcome string.
- **No new runtime dependency. No new exit code. No new artifact type. No schema change** — every schema pins `schemaVersion` with `const`, so a checkpoint field would invalidate every existing run's checkpoint on `validate`.
- ESM: every relative import ends in `.js`. No snapshots (`toMatchSnapshot`/`toMatchInlineSnapshot` appear zero times in `tests/` and must stay at zero).
- **The full gate is nine commands, from a deleted `dist/`:**
  ```bash
  rm -rf dist
  npm run generate:types && npm run check:generated && npm run typecheck && npm run lint \
    && npm run check:examples && npm run test:coverage && npm run build \
    && npm run scan:secrets && npm run smoke:package
  ```
  Coverage floor 90/80/95/90. Baseline at `3565780`: 1216/1216 tests (86 files), coverage 94.04/83.92/98.16/94.04.
- Conventional commit prefix, and every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```
- **Citations in comments name a file, not a line**, unless the line is in the same file. Phase 8a lost three comments to line-number rot and one to citing a mutable document.

---

## File structure

| File | Responsibility |
|---|---|
| Create `src/core/observed-coverage.ts` | Pure: which canonical identities a run's `test-result-batch` artifacts observed, and which `test-case` artifact ids that covers. The single source both the residual and the checkpoint invariant read. |
| Create `src/operations/observed-pause.ts` | Pure-ish predicate: does this run stop and wait for a Runtime-Observed Execution? Mirrors `src/operations/human-input.ts`. |
| Modify `src/operations/run-workflow.ts` | Input field, input checksum, outcome union, pause call site, residual narrowing, the zero-residual amendments, retest `linkedRunId` pre-check. |
| Modify `src/cli/exit-codes.ts` | Map the third non-terminal outcome to `BLOCKED` (2) and keep the documented ordering true. |
| Modify `src/core/inspect-workspace-state.ts:476` | Equality → union coverage. |
| Modify `src/cli/workflow.ts` | `changeScope` → `changeScopeSources` wiring; scaffold emits `charter`, `changeScope`, `linkedRunId`, `retest.sourceBug`; validates `mode`. |
| Modify `src/cli/program.ts` | The four new scaffold options. |
| Modify `README.md`, `skills/shared/references/recovery.md` | The filtered two-lane flow, and the new outcome's remedy. |

---

### Task 1: The observed-coverage reader

**Files:**
- Create: `src/core/observed-coverage.ts`
- Test: `tests/core/observed-coverage.test.ts`

**Interfaces:**
- Consumes: `array`, `isRecord` from `src/core/values.js`.
- Produces, and both later tasks depend on these exact names:
  - `type CoverageArtifactView = Readonly<{ record: Readonly<{ id: string; type: string; sha256: string }>; value?: unknown; valid?: boolean }>`
  - `caseIdentityKey(testCaseId: unknown, revisionId: unknown, instanceId: unknown): string | undefined`
  - `observedCaseIdentities(artifacts: readonly CoverageArtifactView[]): ReadonlySet<string>`
  - `observedCoveredCaseIds(artifacts: readonly CoverageArtifactView[]): ReadonlySet<string>`

Why a structural view type: the two callers hold different artifact shapes — `RegisteredWorkspaceArtifact` in `run-workflow.ts` and the inspection's own loaded artifact in `inspect-workspace-state.ts` (which carries `valid` and an optional `value`). Both satisfy the view structurally, so neither has to be converted.

- [ ] **Step 1: Write the failing test**

`tests/core/observed-coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { caseIdentityKey, observedCaseIdentities, observedCoveredCaseIds } from "../../src/core/observed-coverage.js";

function batch(id: string, entries: readonly Record<string, unknown>[], valid = true) {
  return { record: { id, type: "test-result-batch", sha256: "a".repeat(64) }, value: { entries }, valid };
}

function testCase(id: string, testCaseId: string, revisionId: string, instanceId: string, valid = true) {
  return { record: { id, type: "test-case", sha256: "b".repeat(64) }, value: { testCaseId, revisionId, instanceId }, valid };
}

describe("caseIdentityKey", () => {
  it("joins the triple lane 2 binds an entry on", () => {
    expect(caseIdentityKey("TC-1", "REV-1", "INSTANCE-1")).toBe("TC-1:REV-1:INSTANCE-1");
  });

  it("returns undefined when any part is not a string, so a malformed value cannot forge an identity", () => {
    expect(caseIdentityKey("TC-1", 2, "INSTANCE-1")).toBeUndefined();
    expect(caseIdentityKey("TC-1", "REV-1", undefined)).toBeUndefined();
  });
});

describe("observedCaseIdentities", () => {
  it("reads every entry of every batch in the run", () => {
    const identities = observedCaseIdentities([
      batch("BATCH-1", [{ testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" }]),
      batch("BATCH-2", [{ testCaseId: "TC-2", testCaseRevisionId: "REV-2", testCaseInstanceId: "INSTANCE-2" }]),
    ]);
    expect([...identities].sort()).toEqual(["TC-1:REV-1:INSTANCE-1", "TC-2:REV-2:INSTANCE-2"]);
  });

  it("ignores an invalid batch, so a batch that failed its semantic rule cannot suppress driving", () => {
    const identities = observedCaseIdentities([
      batch("BATCH-1", [{ testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" }], false),
    ]);
    expect(identities.size).toBe(0);
  });

  it("ignores every other artifact type, including a lane-1 test-result carrying the same triple", () => {
    const identities = observedCaseIdentities([
      { record: { id: "RESULT-1", type: "test-result", sha256: "c".repeat(64) }, value: { testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" }, valid: true },
    ]);
    expect(identities.size).toBe(0);
  });
});

describe("observedCoveredCaseIds", () => {
  it("maps an observed identity onto the registered test-case artifact that declares it", () => {
    const covered = observedCoveredCaseIds([
      batch("BATCH-1", [{ testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-1" }]),
      testCase("CASE-1", "TC-1", "REV-1", "INSTANCE-1"),
      testCase("CASE-2", "TC-2", "REV-2", "INSTANCE-2"),
    ]);
    expect([...covered]).toEqual(["CASE-1"]);
  });

  it("covers nothing when the identity differs in the instance alone", () => {
    const covered = observedCoveredCaseIds([
      batch("BATCH-1", [{ testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INSTANCE-OTHER" }]),
      testCase("CASE-1", "TC-1", "REV-1", "INSTANCE-1"),
    ]);
    expect(covered.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/core/observed-coverage.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/core/observed-coverage.js"`. Paste the real output into the task report.

- [ ] **Step 3: Implement the module**

`src/core/observed-coverage.ts`:

```ts
import { array, isRecord } from "./values.js";

/**
 * The identity questions a filtered run asks of lane 2, in one place because two callers ask them and
 * must not disagree: `run-workflow.ts` computes the residual to drive, and `inspect-workspace-state.ts`
 * checks that every selected case was covered by SOME lane. Two independent readers of the same fact is
 * the drift shape this project keeps closing (see the two-readers comments in semantic-rules.ts).
 *
 * The minimum shape both callers already satisfy: a manifest record, an optional parsed value, and the
 * inspection's `valid` flag.
 */
export type CoverageArtifactView = Readonly<{
  record: Readonly<{ id: string; type: string; sha256: string }>;
  value?: unknown;
  valid?: boolean;
}>;

/** `testCaseId:revisionId:instanceId`. The instance is part of the identity: one revision can have
 *  several parameterized instances (see RegressionCase in src/regression/change-scope.ts). */
export function caseIdentityKey(testCaseId: unknown, revisionId: unknown, instanceId: unknown): string | undefined {
  return typeof testCaseId === "string" && typeof revisionId === "string" && typeof instanceId === "string"
    ? `${testCaseId}:${revisionId}:${instanceId}`
    : undefined;
}

/**
 * Every canonical identity a Runtime-Observed Execution in this run actually executed. A batch entry
 * names its identity as `testCaseId`/`testCaseRevisionId`/`testCaseInstanceId` — the same triple
 * src/observed/report-mapping.ts binds an entry on, and the only case identity a batch carries (an entry
 * has no spec path; see src/reporting/projections/spec-locations.ts for where a path is read from).
 *
 * `valid === false` contributes nothing, deliberately: a batch that failed its semantic rule must not be
 * able to suppress driving a case. Absent `valid` is treated as valid, which is what the writing side's
 * artifact view means.
 */
export function observedCaseIdentities(artifacts: readonly CoverageArtifactView[]): ReadonlySet<string> {
  const identities = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.record.type !== "test-result-batch" || artifact.valid === false || !isRecord(artifact.value)) continue;
    for (const entry of array(artifact.value.entries)) {
      if (!isRecord(entry)) continue;
      const key = caseIdentityKey(entry.testCaseId, entry.testCaseRevisionId, entry.testCaseInstanceId);
      if (key !== undefined) identities.add(key);
    }
  }
  return identities;
}

/** The registered `test-case` artifacts whose exact identity a batch entry observed. */
export function observedCoveredCaseIds(artifacts: readonly CoverageArtifactView[]): ReadonlySet<string> {
  const identities = observedCaseIdentities(artifacts);
  const covered = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.record.type !== "test-case" || artifact.valid === false || !isRecord(artifact.value)) continue;
    const key = caseIdentityKey(artifact.value.testCaseId, artifact.value.revisionId, artifact.value.instanceId);
    if (key !== undefined && identities.has(key)) covered.add(artifact.record.id);
  }
  return covered;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/core/observed-coverage.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove each test by mutation**

Apply each mutation, run the file, record the observed failure, restore:

| Mutation | Must redden |
|---|---|
| `artifact.valid === false` → `false` (never skip) | "ignores an invalid batch" |
| `artifact.record.type !== "test-result-batch"` → `!== "test-result"` | "ignores every other artifact type" |
| `caseIdentityKey` returns `` `${testCaseId}:${revisionId}` `` (drop the instance) | "covers nothing when the identity differs in the instance alone" |
| `typeof revisionId === "string"` → `revisionId !== undefined` | "returns undefined when any part is not a string" |

- [ ] **Step 6: Run the full gate** (the nine commands above, from a deleted `dist/`)

- [ ] **Step 7: Commit**

```bash
git add src/core/observed-coverage.ts tests/core/observed-coverage.test.ts
git commit -m "feat: read which canonical identities lane 2 observed, in one place

Two callers need this fact and must not derive it twice: the residual the
browser lane drives, and the checkpoint invariant that every selected case was
covered by some lane. An invalid batch contributes nothing, so a batch that
failed its semantic rule cannot suppress driving a case.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The pause — `AWAITING_OBSERVED_EXECUTION`

**Files:**
- Create: `src/operations/observed-pause.ts`
- Modify: `src/operations/run-workflow.ts` (input type ~:114-125, `workflowInputChecksum` :138-140, `WorkflowResult` :88, the operation loop ~:983-999)
- Modify: `src/cli/exit-codes.ts` (the doc comment :14-32 and `workflowExitCode` :33-41)
- Test: `tests/operations/observed-execution-pause.test.ts`

**Interfaces:**
- Consumes: `observedCaseIdentities` from Task 1.
- Produces:
  - `type PendingObservedExecution = Readonly<{ operation: WorkflowOperationName; command: "execute playwright"; reason: string }>`
  - `pendingObservedExecution(workspace: RunWorkspace, operation: WorkflowOperationName, expected: boolean): Promise<PendingObservedExecution | undefined>`
  - `QaWorkflowInput.observedExecution?: Readonly<{ expected: true }>`
  - `WorkflowResult.outcome` gains `"AWAITING_OBSERVED_EXECUTION"`, and `WorkflowResult.pendingObservedExecution?: PendingObservedExecution`

This task does NOT add the residual. After the pause, a resume drives the whole selection — so every existing invariant still holds, and the task is reviewable on its own. Task 3 adds the narrowing.

- [ ] **Step 1: Write the failing tests**

`tests/operations/observed-execution-pause.test.ts`. Copy the fixture helpers from `tests/operations/awaiting-human-input.test.ts` — `planBundle`/`regressionTester`/`regressionInput`/`registeredArtifacts`/`runStatus` (that file's `regressionTester` at :204 registers `browserManagers: { chromium: { browser } }`, an `evidencePolicies.required` policy, and `changeScopeSources.trusted` with one change mapping `REQ-REG`). Add:

```ts
it("pauses before execute-browser-test when the run expects a Runtime-Observed Execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-observed-pause-")); roots.push(root);
  const bundle = await planBundle(root, {});

  const paused = await regressionTester()({ ...regressionInput(root, bundle), observedExecution: { expected: true } });

  expect(paused.outcome).toBe("AWAITING_OBSERVED_EXECUTION");
  expect(paused.pendingObservedExecution).toMatchObject({ operation: "execute-browser-test", command: "execute playwright" });
  // Consequence, not just the outcome string: the selection ran, nothing was driven, no gate exists,
  // and the run is still writable.
  const artifacts = await registeredArtifacts(root, paused.runId);
  expect(artifacts.some((artifact) => artifact.record.type === "regression-selection")).toBe(true);
  expect(artifacts.filter((artifact) => artifact.record.type === "test-result")).toHaveLength(0);
  expect(artifacts.some((artifact) => artifact.record.type === "release-gate")).toBe(false);
  expect(await runStatus(root, paused.runId)).toBe("IN_PROGRESS");
});

it("pauses again on a resume that still has no observed execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-observed-pause-again-")); roots.push(root);
  const bundle = await planBundle(root, {});
  const tester = regressionTester();
  const first = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });

  const second = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: first.runId });

  expect(second.outcome).toBe("AWAITING_OBSERVED_EXECUTION");
  expect(second.runId).toBe(first.runId);
  expect((await registeredArtifacts(root, first.runId)).filter((artifact) => artifact.record.type === "test-result")).toHaveLength(0);
});

it("does not pause when the input declares no observed execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-observed-absent-")); roots.push(root);
  const bundle = await planBundle(root, {});

  const result = await regressionTester()(regressionInput(root, bundle));

  expect(result.outcome).toBe("COMPLETED");
  expect((await registeredArtifacts(root, result.runId)).filter((artifact) => artifact.record.type === "test-result")).toHaveLength(1);
});

it("resumes and drives the selection once a batch exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-observed-resume-")); roots.push(root);
  const bundle = await planBundle(root, {});
  const tester = regressionTester();
  const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
  await registerObservedBatch(root, paused.runId, { testCaseId: "TC-REG-OTHER", revisionId: "REV-OTHER", instanceId: "INSTANCE-OTHER" });

  const resumed = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });

  expect(resumed.outcome).toBe("COMPLETED");
  expect((await registeredArtifacts(root, paused.runId)).filter((artifact) => artifact.record.type === "test-result")).toHaveLength(1);
});

it("rejects a resume whose observedExecution disagrees with the paused run", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-observed-checksum-")); roots.push(root);
  const bundle = await planBundle(root, {});
  const tester = regressionTester();
  const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });

  await expect(tester({ ...regressionInput(root, bundle), resumeRunId: paused.runId }))
    .rejects.toThrow(/checkpoint|input|checksum/i);
});
```

The fourth test needs a batch whose identity is deliberately NOT in the selection, so this task's resume still drives the one selected case. Add this helper to the test file — the values satisfy `test-result-batch` 3.0.0 and its semantic rule (unique `entryId`; `PASSED` pairs with `failureClassification: "NONE"`; no evidence on a passing entry; the entry binds to a registered `test-case` on the triple, which is why the helper registers its own case):

```ts
/** Registers a lane-2 batch into an open (paused) run, without running Playwright. */
async function registerObservedBatch(root: string, runId: string, identity: { testCaseId: string; revisionId: string; instanceId: string }) {
  const workspace = await RunWorkspace.open(root, runId);
  try {
    const testCase = await workspace.registerArtifactValue({ type: "test-case", relationships: [], provenance: "agent-draft", value: {
      artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0",
      testCaseId: identity.testCaseId, revisionId: identity.revisionId, instanceId: identity.instanceId,
      title: "Observed by lane 2", steps: [{ id: "observed-open", action: "navigate", sideEffect: "none" }],
      coverage: { requirementId: "REQ-REG", role: "member", behavior: "observed", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved" },
    } });
    await workspace.registerArtifactValue({ type: "test-result-batch", relationships: [testCase.id], provenance: "runtime-observed", value: {
      artifactType: "test-result-batch", schemaVersion: "3.0.0", producerVersion: "1.0.0",
      executionId: `EXEC-${identity.testCaseId}`, runId, commitSha: "0".repeat(40), specTreeSha256: "1".repeat(64),
      startedAt: "2026-07-31T00:00:00.000Z", finishedAt: "2026-07-31T00:00:01.000Z",
      entries: [{
        entryId: "ENTRY-1", testCaseId: identity.testCaseId, testCaseRevisionId: identity.revisionId, testCaseInstanceId: identity.instanceId,
        status: "PASSED", failureClassification: "NONE", executionSurface: "api",
        steps: [{ stepId: "observed-open", status: "PASSED", durationMs: 5 }],
      }],
    } });
  } finally { await workspace.close(); }
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/operations/observed-execution-pause.test.ts`
Expected: FAIL — the first test fails on `outcome` being `"COMPLETED"` (the field is ignored today), and TypeScript rejects `observedExecution` as an unknown property. Paste both.

- [ ] **Step 3: Add the input field and put it in the checksum**

In `src/operations/run-workflow.ts`, extend `QaWorkflowInput` (after `retest?:`):

```ts
  /** Declares that a Runtime-Observed Execution (`qa-skill execute playwright`) will supply part of this
   *  run's execution. The run pauses in front of `execute-browser-test` until a batch exists; see
   *  src/operations/observed-pause.ts for the predicate. */
  observedExecution?: Readonly<{ expected: true }>;
```

and add it to the checksum:

```ts
function workflowInputChecksum(input: QaWorkflowInput): string {
  return sha256Text(JSON.stringify({ mode: input.mode, environmentProfile: input.environmentProfile, bundle: input.bundle, linkedRunId: input.linkedRunId, testDataHookIds: input.runtime?.testDataHookIds, charter: input.charter, retest: input.retest, observedExecution: input.observedExecution }));
}
```

- [ ] **Step 4: Write the pause predicate**

`src/operations/observed-pause.ts`:

```ts
import { observedCaseIdentities } from "../core/observed-coverage.js";
import type { WorkflowOperationName } from "../core/modes.js";
import type { RunWorkspace } from "../core/run-workspace.js";

/** What a run paused for lane 2 tells its caller: the command that clears it, and why it stopped.
 *  `AWAITING_RUNTIME` returns a bare outcome because its remedy is a caller-side registry; this one, like
 *  `AWAITING_HUMAN_INPUT`, names a command a person is expected to run. */
export type PendingObservedExecution = Readonly<{
  operation: WorkflowOperationName;
  command: "execute playwright";
  reason: string;
}>;

/**
 * Stops in front of `execute-browser-test` while a filtered run still has no Runtime-Observed Execution.
 *
 * The condition is deliberately "no observed identity yet" rather than "no `test-result-batch` record":
 * a batch that failed its semantic rule observed nothing anybody can credit, so it must not clear the
 * pause — the same reason `observedCaseIdentities` (src/core/observed-coverage.ts) ignores it when
 * computing the residual. One fact, one reader.
 *
 * Self-clearing and idempotent: a resume with still no batch pauses again identically, which is what
 * stops a resume from silently falling back to driving the whole selection.
 */
export async function pendingObservedExecution(
  workspace: RunWorkspace,
  operation: WorkflowOperationName,
  expected: boolean,
): Promise<PendingObservedExecution | undefined> {
  if (!expected || operation !== "execute-browser-test") return undefined;
  if (observedCaseIdentities(await workspace.readRegisteredArtifacts()).size > 0) return undefined;
  return {
    operation,
    command: "execute playwright",
    reason: "The run expects a Runtime-Observed Execution: run `qa-skill execute playwright --root <root> --run-id <runId> --spec-dir <dir>`, then resume with resumeRunId.",
  };
}
```

- [ ] **Step 5: Widen the result and pause in the loop**

In `run-workflow.ts`, import the module, add the outcome to `WorkflowResult`:

```ts
export type WorkflowResult = Readonly<{ runId: string; mode: PublicWorkflowMode; outcome: "AWAITING_RUNTIME" | "AWAITING_HUMAN_INPUT" | "AWAITING_OBSERVED_EXECUTION" | WorkflowTerminalStatus; operationOrder: readonly WorkflowOperationName[]; outputs: Readonly<CorrelatedWorkflowOutputs>; validation: WorkspaceValidation; releaseRecommendation?: ReleaseRecommendation; pendingHumanInput?: PendingHumanInput; pendingObservedExecution?: PendingObservedExecution }>;
```

Update the TSDoc at `:83` so it says three non-terminal outcomes, not two. Then, in the operation loop, immediately after the `pendingHumanInput` block:

```ts
      // The observed-execution checkpoint. Same position and same four properties as the human one
      // above — registers nothing, advances no checkpoint, never finalizes, leaves the workspace
      // writable — because the command that clears it (`qa-skill execute playwright`) registers INTO
      // this run. Placed after the human pause so a run that needs both reports the human one first:
      // an approval is a precondition of driving anything, and the operator can record it while the
      // observed suite runs.
      const observed = await pendingObservedExecution(workspace, name, input.observedExecution?.expected === true);
      if (observed !== undefined) {
        return { runId: workspace.runId, mode: input.mode, outcome: "AWAITING_OBSERVED_EXECUTION", operationOrder: order, outputs, validation: await workspace.validate(input.mode), pendingObservedExecution: observed };
      }
```

- [ ] **Step 6: Map the outcome to an exit code**

In `src/cli/exit-codes.ts`, add the branch beside its siblings and extend the ordered comment (the comment is the contract; leaving it at two non-terminal outcomes makes it false):

```ts
  if (result.outcome === "AWAITING_OBSERVED_EXECUTION") return ExitCode.BLOCKED;
```

Comment edit: renumber so the list reads `4. AWAITING_HUMAN_INPUT … -> BLOCKED (2)`, `5. AWAITING_OBSERVED_EXECUTION (waiting on an observed suite) -> BLOCKED (2)`, and change "Both non-terminal outcomes resolve ahead of `validation.valid`" to "All three non-terminal outcomes resolve ahead of `validation.valid`".

- [ ] **Step 7: Run the tests and watch them pass**

Run: `npx vitest run tests/operations/observed-execution-pause.test.ts tests/cli/workflow-run-exit-code.test.ts`
Expected: PASS.

- [ ] **Step 8: Add the exit-code test**

In `tests/cli/workflow-run-exit-code.test.ts` (which mocks `runLocalWorkflow`), add a case asserting `AWAITING_OBSERVED_EXECUTION` → exit 2. Then mutate: delete the new branch in `workflowExitCode` and watch that case go red (it falls through to `SUCCESS` because `validation.valid` is true in the mock).

- [ ] **Step 9: Prove each test by mutation**

| Mutation | Must redden |
|---|---|
| `if (!expected \|\| operation !== "execute-browser-test")` → `if (!expected)` | one of the pause tests, by pausing in front of `select-regression` before a selection exists |
| `!expected` → `false` (always eligible) | "does not pause when the input declares no observed execution" |
| `observedCaseIdentities(...).size > 0` → `false` | "resumes and drives the selection once a batch exists" (pauses forever) |
| drop `observedExecution` from `workflowInputChecksum` | "rejects a resume whose observedExecution disagrees" |
| delete the `AWAITING_OBSERVED_EXECUTION` branch in `workflowExitCode` | the new exit-code case |

- [ ] **Step 10: Run the full gate**

- [ ] **Step 11: Commit**

```bash
git add src/operations/observed-pause.ts src/operations/run-workflow.ts src/cli/exit-codes.ts tests/operations/observed-execution-pause.test.ts tests/cli/workflow-run-exit-code.test.ts
git commit -m "feat: pause a filtered run for a Runtime-Observed Execution

A third non-terminal outcome, in the position the human pause already occupies:
it registers nothing, advances no checkpoint, never finalizes, and leaves the
workspace writable -- which it must, because the command that clears it registers
into this same run.

The pause condition is 'no observed identity yet', not 'no batch record'. A batch
that failed its semantic rule observed nothing creditable, so it does not clear
the pause, for the same reason it cannot suppress driving a case.

observedExecution joins workflowInputChecksum, so a resume that disagrees with
the paused run about its own shape is refused rather than honoured.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The residual, and the three guards that assumed one lane

**Files:**
- Modify: `src/operations/run-workflow.ts` (the `execute-browser-test` dispatch :1073-1083, `assertResultPostcondition` :212-215)
- Modify: `src/core/inspect-workspace-state.ts` (:476)
- Test: `tests/operations/observed-execution-residual.test.ts`
- Test: extend `tests/core/inspect-workspace-state.test.ts` (or the nearest existing checkpoint-invariant suite — find it with `grep -rn "executionCases" tests/`)

**Interfaces:**
- Consumes: `observedCaseIdentities`, `observedCoveredCaseIds` (Task 1); the pause from Task 2.
- Produces: no new exported name. Behaviour: `execute-browser-test` in a non-`retest` mode drives `state.executionCaseIds` minus observed-covered ids, and zero driven attempts is legal exactly when the observed set covers every selected case.

**The three guards, quoted as they are today.** All three encode "driven == selected", which residual driving breaks:

```ts
// run-workflow.ts:1082 — non-retest branch of execute-browser-test
if (state.executionCaseIds.length === 0) throw new QaSkillsError("Runtime execution requires imported approved canonical test cases", "ARTIFACT_BINDING");
// run-workflow.ts:214 — assertResultPostcondition, shared with reproduce-bug (:257)
if (output.length === 0 || output.some((item) => item.type !== "test-result")) throw new QaSkillsError("Execution operation must return registered test-result references", "ARTIFACT_BINDING");
// inspect-workspace-state.ts:476
&& (!completed.includes("execute-browser-test") || value.mode === "retest" || sameCheckpointRefs(array(state.executionCases), executionCaseRefs))
```

Note for the implementer: `snapshotWorkflowState` (`run-workflow.ts:283`) writes checkpoint `state.executionCases` from the SELECTION (`selectedExecutionCases`), never from the narrowed drive list — which is why `retest`, whose drive list is already narrowed at `:1060-1071`, is exempted at `:476`. So narrowing `state.executionCaseIds` does not change what the checkpoint records; only `:476`'s comparison needs to change.

**Verification item, do this first and report it:** `assertResultPostcondition` is shared with `reproduce-bug` (`:257`). Measure whether `reproduce-bug` can legitimately produce an empty output before deciding where the zero-output allowance goes. If it cannot, condition the allowance on the observed-coverage question rather than relaxing the postcondition for every caller.

- [ ] **Step 1: Write the failing tests**

`tests/operations/observed-execution-residual.test.ts`, reusing Task 2's fixtures and `registerObservedBatch`, plus a bundle with two selected cases (`planBundle` with two cases both mapping `REQ-REG`; copy the two-case shape from `tests/orchestration/runtime-public.e2e.test.ts`'s `sourceBundle(root, { sourceBug: "partial" })` usage):

```ts
it("drives only the selected cases lane 2 did not observe", async () => {
  // selection = {TC-REG-A, TC-REG-B}; lane 2 observed TC-REG-A
  const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
  await registerObservedBatch(root, paused.runId, { testCaseId: "TC-REG-A", revisionId: "REV-A", instanceId: "INSTANCE-A" });

  const resumed = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });

  const attempts = (await registeredArtifacts(root, paused.runId)).filter((artifact) => artifact.record.type === "test-result");
  expect(attempts).toHaveLength(1);
  expect(attempts[0]?.value).toMatchObject({ testCaseId: "TC-REG-B" });
  expect(resumed.outcome).toBe("COMPLETED");
  expect(resumed.validation.valid).toBe(true);
});

it("completes with zero driven attempts when lane 2 observed the whole selection", async () => {
  const paused = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true } });
  await registerObservedBatch(root, paused.runId, { testCaseId: "TC-REG-A", revisionId: "REV-A", instanceId: "INSTANCE-A" });
  await registerObservedBatch(root, paused.runId, { testCaseId: "TC-REG-B", revisionId: "REV-B", instanceId: "INSTANCE-B" });

  const resumed = await tester({ ...regressionInput(root, bundle), observedExecution: { expected: true }, resumeRunId: paused.runId });

  expect((await registeredArtifacts(root, paused.runId)).filter((artifact) => artifact.record.type === "test-result")).toHaveLength(0);
  expect(resumed.outcome).toBe("COMPLETED");
  expect(resumed.validation.valid).toBe(true);
});

it("still refuses a run with no cases and no observed execution", async () => {
  // No observedExecution field, and a change scope that selects nothing.
  await expect(emptySelectionTester()(regressionInput(root, bundle)))
    .rejects.toThrow("Runtime execution requires imported approved canonical test cases");
});
```

And the invariant's other direction, in the checkpoint-invariant suite — after a residual-driven run, remove the entry that covered the case nobody drove and re-open:

```ts
it("invalidates a checkpoint whose selected case was covered by neither lane", async () => {
  // ... residual-driven run as above ...
  const workspace = await RunWorkspace.open(root, runId);
  const batch = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "test-result-batch");
  if (!batch) throw new Error("Expected an observed batch");
  await rechecksumRegisteredArtifact(workspace, batch.record.id, (value) => {
    const entries = value.entries as Record<string, unknown>[];
    entries[0]!.testCaseInstanceId = "INSTANCE-NEVER-SELECTED";
  });
  await workspace.close();

  await expect(RunWorkspace.open(root, runId)).rejects.toThrow(/checkpoint|execution|binding|reference/i);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/operations/observed-execution-residual.test.ts`
Expected: FAIL — the first test drives 2 attempts, the second throws `Runtime execution requires imported approved canonical test cases`. Paste both.

- [ ] **Step 3: Narrow the drive list**

In the non-`retest` branch of the `execute-browser-test` dispatch:

```ts
    // A filtered run's selection is one filter over TWO lanes: whatever a Runtime-Observed Execution
    // already covered is not driven again. The identity compared is the triple a batch entry carries
    // (src/core/observed-coverage.ts); nothing here reads a spec path, because an entry has none.
    const all = await artifacts();
    const observedCases = observedCoveredCaseIds(all);
    const residual = state.executionCaseIds.filter((id) => !observedCases.has(id));
    // Zero residual is legal ONLY when observation covers the whole selection. The original refusal
    // still fires for the state its message describes: nothing to execute and nothing observed either.
    if (residual.length === 0 && state.executionCaseIds.length === 0) throw new QaSkillsError("Runtime execution requires imported approved canonical test cases", "ARTIFACT_BINDING");
    if (residual.length === 0) return [] as unknown as WorkflowOperationOutputMap[Name];
    return executeWithRuntime(workspace, runtime, input.runtime ?? {}, residual) as Promise<WorkflowOperationOutputMap[Name]>;
```

- [ ] **Step 4: Allow an empty output only for a fully observed selection**

`assertResultPostcondition` is shared with `reproduce-bug`, so do not relax it unconditionally. Add the observed question to it:

```ts
async function assertResultPostcondition(workspace: RunWorkspace, output: readonly ArtifactRecord[]): Promise<void> {
  await assertRegisteredArtifacts(workspace, output);
  const artifacts = await workspace.readRegisteredArtifacts();
  // An empty output is legal in exactly one state: a filtered run whose whole selection was covered by a
  // Runtime-Observed Execution, so there was nothing left to drive. Anything else empty is the bug this
  // check was written for — an execution operation that registered nothing and reported success.
  const observedNothing = observedCaseIdentities(artifacts).size === 0;
  if ((output.length === 0 && observedNothing) || output.some((item) => item.type !== "test-result")) throw new QaSkillsError("Execution operation must return registered test-result references", "ARTIFACT_BINDING");
  // ... rest unchanged, and note the pre-existing `const artifacts = await workspace.readRegisteredArtifacts()`
  // below must be REMOVED, not duplicated: it is now read above.
```

- [ ] **Step 5: Turn the checkpoint equality into union coverage**

In `src/core/inspect-workspace-state.ts`, beside `executionCaseRefs`:

```ts
    // Union coverage, not equality: a filtered run drives only the cases lane 2 did not observe, so the
    // selection is satisfied by a driven `test-result` OR a `test-result-batch` entry carrying the same
    // identity. Observed cases are intersected with the checkpoint's own selection first, so a lane-2
    // suite that ran EXTRA tagged specs cannot widen what this checkpoint claims. The check stays total:
    // a selected case covered by neither lane still invalidates.
    const selectedIds = new Set(array(state?.executionCases).flatMap((item) => isRecord(item) && typeof item.artifactId === "string" ? [item.artifactId] : []));
    const observedSelectedRefs = [...observedCoveredCaseIds(artifacts)].filter((id) => selectedIds.has(id)).flatMap((id) => {
      const artifact = artifacts.find((candidate) => candidate.record.id === id);
      return artifact === undefined ? [] : [{ artifactId: artifact.record.id, sha256: artifact.record.sha256 }];
    });
```

and change `:476` to:

```ts
      && (!completed.includes("execute-browser-test") || value.mode === "retest" || sameCheckpointRefs(array(state.executionCases), [...executionCaseRefs, ...observedSelectedRefs]))
```

`sameCheckpointRefs` normalizes and sorts, so duplicate coverage of one case (driven AND observed) would break equality — assert in a test that this cannot arise, because the residual excludes observed cases from driving.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx vitest run tests/operations/observed-execution-residual.test.ts tests/operations/observed-execution-pause.test.ts tests/core/inspect-workspace-state.test.ts`
Expected: PASS.

- [ ] **Step 7: Prove each test by mutation**

| Mutation | Must redden |
|---|---|
| `residual` → `state.executionCaseIds` (drive everything) | "drives only the selected cases lane 2 did not observe" |
| `if (residual.length === 0) return []` deleted | "completes with zero driven attempts" |
| `residual.length === 0 && state.executionCaseIds.length === 0` → `residual.length === 0` | "still refuses a run with no cases and no observed execution" |
| `observedNothing` → `true` in the postcondition | "completes with zero driven attempts" |
| `observedSelectedRefs` → `[]` at `:476` | "drives only the selected cases lane 2 did not observe" (validation invalid) |
| drop the `selectedIds.has(id)` intersection | a test where lane 2 observed an unselected case — add one if none exists |

- [ ] **Step 8: Run the full gate**

- [ ] **Step 9: Commit**

```bash
git add src/operations/run-workflow.ts src/core/inspect-workspace-state.ts tests/operations/observed-execution-residual.test.ts tests/core/inspect-workspace-state.test.ts
git commit -m "fix: drive only what lane 2 did not observe, and ask coverage of both lanes

Three guards encoded 'driven == selected' and all three break once a selection
spans two lanes: the zero-case refusal in execute-browser-test, the empty-output
refusal in assertResultPostcondition, and the checkpoint equality at
inspect-workspace-state.ts. Each becomes the same union-coverage question, and
none is deleted -- the zero-case refusal still fires for a run with nothing to
execute and nothing observed either.

Observed cases are intersected with the checkpoint's own selection before the
comparison, so a lane-2 suite that ran extra tagged specs cannot widen what a
checkpoint claims.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The CLI wiring the three unreachable modes need

**Files:**
- Modify: `src/cli/workflow.ts` (`ScaffoldOptions` :17, `scaffoldWorkflowInput` :65-97, `runLocalWorkflow` :100-123)
- Modify: `src/cli/program.ts` (the `scaffold` command :133-142)
- Modify: `src/operations/run-workflow.ts` (production `retest` pre-check beside `:971`)
- Test: `tests/cli/workflow.test.ts`

**Interfaces:**
- Produces:
  - `ScaffoldOptions` gains `charterPath?: string; changeScopePath?: string; bugRunId?: string; bugArtifactId?: string`, and `mode: PublicWorkflowMode`.
  - The scaffolded input may now carry `charter`, `changeScope`, `linkedRunId`, `retest`, and `runtime.changeScopeSourceId: "local-change-scope"`.
  - `runLocalWorkflow` registers `changeScopeSources: { "local-change-scope": input.changeScope }`.

Measured starting point, do not re-derive: `runLocalWorkflow` registers only `browserManagers`, `testDataRegistries`, `evidencePolicies` (`workflow.ts:117-121`), so `resolveRuntime(runtime.changeScopeSources, …)` at `run-workflow.ts:972`/`:1055` can never resolve and `retest`/`regression` are unreachable through `workflow run` even with a hand-edited input.

- [ ] **Step 1: Write the failing tests**

In `tests/cli/workflow.test.ts`:

```ts
it("refuses a mode that is not a public workflow mode", async () => {
  await expect(scaffoldWorkflowInput({ root, mode: "regresion", outputPath: join(root, "typo.json"), environmentPath: envPath }))
    .rejects.toThrow(/mode/i);
});

it("inlines a change scope so the run input stays one closed file", async () => {
  const scopePath = join(root, "scope.json");
  await writeFile(scopePath, JSON.stringify({ changes: [{ id: "CHG-1", requirementIds: ["REQ-1"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }], provenance: { kind: "declared-change", reference: "PR-482" } }));

  const input = await scaffoldWorkflowInput({ root, mode: "regression", outputPath: join(root, "regression.json"), environmentPath: envPath, changeScopePath: scopePath });

  expect(input.changeScope).toMatchObject({ provenance: { kind: "declared-change", reference: "PR-482" } });
  expect(input.runtime).toMatchObject({ changeScopeSourceId: "local-change-scope" });
});

it("refuses a change scope declaring no changes, at the edge", async () => {
  const scopePath = join(root, "empty-scope.json");
  await writeFile(scopePath, JSON.stringify({ changes: [], provenance: { kind: "declared-change", reference: "PR-0" } }));

  await expect(scaffoldWorkflowInput({ root, mode: "regression", outputPath: join(root, "empty.json"), environmentPath: envPath, changeScopePath: scopePath }))
    .rejects.toThrow(/change/i);
});

it("validates a charter at scaffold time rather than deep in the run", async () => {
  const charterPath = join(root, "charter.json");
  await writeFile(charterPath, JSON.stringify({ charterId: "CHARTER-1", mission: "explore checkout", scope: ["checkout"], roles: ["member"], heuristics: ["follow the money"], safetyRules: ["RULE-1"], actions: [{ actionId: "ACT-1", target: "/checkout", kind: "navigate", sideEffect: "none", safetyRuleId: "RULE-1" }], actionBudget: 5, timeBudgetMinutes: 10, stopConditions: ["budget spent"] }));

  const input = await scaffoldWorkflowInput({ root, mode: "exploratory", outputPath: join(root, "exploratory.json"), environmentPath: envPath, charterPath });

  expect(input.charter).toMatchObject({ charterId: "CHARTER-1" });
});

it("refuses a charter whose action list exceeds its budget", async () => {
  const charterPath = join(root, "over-budget.json");
  await writeFile(charterPath, JSON.stringify({
    charterId: "CHARTER-2", mission: "explore checkout", scope: ["checkout"], roles: ["member"],
    heuristics: ["follow the money"], safetyRules: ["RULE-1"],
    actions: [{ actionId: "ACT-1", target: "/checkout", kind: "navigate", sideEffect: "none", safetyRuleId: "RULE-1" }],
    actionBudget: 0, timeBudgetMinutes: 10, stopConditions: ["budget spent"],
  }));

  await expect(scaffoldWorkflowInput({ root, mode: "exploratory", outputPath: join(root, "over-budget-input.json"), environmentPath: envPath, charterPath }))
    .rejects.toThrow(/budget/i);
});

it("reads the retest source bug and its checksum from the named run's manifest", async () => {
  // `executedRunWithBug` is NOT a new invention: build it by lifting the `options.sourceBug` half of
  // `sourceBundle` in tests/orchestration/runtime-public.e2e.test.ts:42-82 — a run created with
  // `mode: "execute"`, holding the requirement/plan/test-case set, one `test-result` with
  // `status: "FAILED"` and `failureClassification: "PRODUCT_DEFECT"` bound to the case, a `bug-report`
  // generated from it, then `finalize("execute")`. Return `{ runId, bugArtifactId, bugSha256 }`.
  //
  // TWO RUNS ARE REQUIRED HERE, and this is a consequence of the design rather than a fixture quirk:
  // scaffold's bundle path refuses a run holding non-planning artifacts (src/cli/workflow.ts:85), so the
  // executed run above cannot supply the bundle. `planRunId` is a separate planning-only terminal run
  // carrying the SAME identity triples (retest matches its bundle to the source scenarios by
  // testCaseId/revisionId/instanceId at run-workflow.ts:1041, not by artifact id). The library tests get
  // away with one run because they bypass scaffold entirely and pass `bundle` and `linkedRunId` as the
  // same run id (runtime-public.e2e.test.ts:561).
  const executed = await executedRunWithBug(root);   // a terminal run holding exactly one bug-report

  const input = await scaffoldWorkflowInput({ root, mode: "retest", outputPath: join(root, "retest.json"), sourceRoot: root, sourceRunId: planRunId, bugRunId: executed.runId });

  expect(input.linkedRunId).toBe(executed.runId);
  expect(input.retest).toMatchObject({ sourceBug: { artifactId: executed.bugArtifactId, sha256: executed.bugSha256 } });
});

it("refuses a bug run holding several bug reports unless one is named", async () => {
  const executed = await executedRunWithBug(root, { bugs: 2 });
  await expect(scaffoldWorkflowInput({ root, mode: "retest", outputPath: join(root, "ambiguous.json"), sourceRoot: root, sourceRunId: planRunId, bugRunId: executed.runId }))
    .rejects.toThrow(/bug/i);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/cli/workflow.test.ts`
Expected: FAIL — TypeScript rejects the new option names; the mode-typo test resolves instead of throwing. Paste both.

- [ ] **Step 3: Implement the scaffold changes**

In `src/cli/workflow.ts`: import `publicWorkflowModes` from `../core/modes.js` and `assertExplorationCharter` from `../exploratory/charter.js`; type `ScaffoldOptions.mode` as `string` still at the CLI edge but validate immediately:

```ts
  if (!(publicWorkflowModes as readonly string[]).includes(options.mode)) throw new QaSkillsError(`Workflow mode must be one of ${publicWorkflowModes.join(", ")}`, "INVALID_ARTIFACT");
```

Read and inline the charter (validated) and the change scope (non-empty `changes`, matching `registerChangeScope`'s own refusal in `src/regression/change-scope.ts`), and resolve the bug reference from the named run's manifest — terminal status required, exactly the check the bundle path already applies at `:73`; refuse zero `bug-report`s, and refuse two or more unless `bugArtifactId` names one. Emit:

```ts
  const input: Record<string, unknown> = {
    root: resolve(options.root), mode: options.mode, environmentProfile,
    ...(bundle === undefined ? {} : { bundle }),
    ...(charter === undefined ? {} : { charter }),
    ...(changeScope === undefined ? {} : { changeScope, runtime: { changeScopeSourceId: "local-change-scope" } }),
    ...(sourceBug === undefined ? {} : { linkedRunId: options.bugRunId, retest: { sourceBug } }),
  };
```

- [ ] **Step 4: Wire the change-scope source into `runLocalWorkflow`**

```ts
    return await createQaTester({
      ...(browser === undefined ? {} : { browserManagers: { "local-browser": { browser } } }),
      testDataRegistries: { "local-data": data },
      // The registry the CLI could not populate before this branch: without it
      // resolveRuntime(runtime.changeScopeSources, ...) can never resolve, so retest and regression were
      // unreachable through `workflow run` no matter what the input file said (wart MODE-1).
      ...(isRecord(parsed.changeScope) ? { changeScopeSources: { "local-change-scope": parsed.changeScope as never } } : {}),
      evidencePolicies: { /* unchanged */ },
    })(input);
```

and make sure the runtime block passed into the input keeps `changeScopeSourceId` when the input declares it (the existing `...(isRecord(parsed.runtime) ? parsed.runtime : {})` spread already does; verify with a test rather than by reading).

- [ ] **Step 5: Add the four CLI options**

In `src/cli/program.ts`, on the `scaffold` command:

```ts
    .option("--charter-file <path>", "Path to an exploration charter JSON file (exploratory mode)")
    .option("--change-scope-file <path>", "Path to a change scope JSON file, inlined into the input (retest and regression modes)")
    .option("--bug-run-id <id>", "Terminal run ID holding the bug report a retest reproduces")
    .option("--bug-artifact-id <id>", "Which bug report in --bug-run-id, when it holds several")
```

and thread each into `scaffoldWorkflowInput` with the same `...(x === undefined ? {} : { … })` shape the existing options use.

- [ ] **Step 6: Add the production retest `linkedRunId` pre-check**

Beside `run-workflow.ts:971`:

```ts
      // The unsafe seam already pre-checks this (see the runWorkflowWithRegistry branch in this file);
      // without the same check here a scaffolded retest fails later, inside reproduce-bug, with a
      // message about the source run rather than about the missing link.
      if (!input.linkedRunId) throw new QaSkillsError("Retest creates a linked immutable run", "ARTIFACT_BINDING");
```

- [ ] **Step 7: Run the tests and watch them pass**

Run: `npx vitest run tests/cli/workflow.test.ts`
Expected: PASS.

- [ ] **Step 8: Prove each test by mutation**

| Mutation | Must redden |
|---|---|
| delete the `publicWorkflowModes` check | "refuses a mode that is not a public workflow mode" |
| `changes.length === 0` check deleted | "refuses a change scope declaring no changes" |
| skip `assertExplorationCharter` | "refuses a charter whose action list exceeds its budget" |
| return the first `bug-report` when several exist | "refuses a bug run holding several bug reports" |
| drop `changeScopeSources` from `runLocalWorkflow` | Task 5's regression CLI test |
| drop the `linkedRunId` pre-check | Task 5's retest CLI test (different message) |

- [ ] **Step 9: Run the full gate**

- [ ] **Step 10: Commit**

```bash
git add src/cli/workflow.ts src/cli/program.ts src/operations/run-workflow.ts tests/cli/workflow.test.ts
git commit -m "feat: let the CLI supply a change scope, a charter and a retest source

No CLI path populated changeScopeSources, so retest and regression were
unreachable through workflow run even with a hand-edited input file -- the
measured half of wart MODE-1. The change scope is authored inline and inlined by
scaffold, so a run input stays one closed file whose checksum covers content
rather than a path.

Scaffold refuses at the edge: an unknown mode (previously written out silently),
a charter its own validator rejects, a change scope declaring no changes, and a
bug run with zero or ambiguous bug reports. The retest reference and its checksum
are read from the named run's manifest, never typed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: All six modes, proven at the CLI

**Files:**
- Test: `tests/cli/workflow-modes.test.ts` (create)

**Interfaces:**
- Consumes: everything from Tasks 2–4. Adds no production code. If a mode cannot be reached, that is a finding to report, not a test to weaken.

Measured starting point: CLI end-to-end coverage today is `plan` (`tests/cli/workflow.test.ts:110-112`) and `full` (`tests/operations/awaiting-human-input.test.ts:243`). `execute`, `exploratory`, `retest`, `regression` are library-only, through `createQaTester` in `tests/orchestration/runtime-public.e2e.test.ts`. Closing MODE-1 means each of the six runs through `runCli(["workflow", "run", "--input", …])`.

- [ ] **Step 1: Write the six failing tests**

One test per mode, each asserting the outcome, the exit code, and one registered artifact that proves the mode's own work happened:

| Mode | Input built by | Asserts |
|---|---|---|
| `plan` | `scaffold --mode plan --environment-file` | outcome `COMPLETED`, exit 0, three planning artifact types registered |
| `execute` | scaffold + a terminal plan bundle | one `test-result` registered |
| `full` | scaffold + bundle | a `release-gate` registered |
| `exploratory` | scaffold `--charter-file` | an `exploration-charter` registered |
| `regression` | scaffold `--change-scope-file` | a `regression-selection` registered, and exactly the selected case driven |
| `retest` | scaffold `--change-scope-file --bug-run-id` | a `retest-result` registered |

Use `runCli` and parse `stdout` as `WorkflowResult`, exactly as `tests/operations/awaiting-human-input.test.ts:243` does. Each test asserts `stderr === ""` on the success path — a mode that "works" while printing an error is not reachable.

Two of the six in full, as the pattern for the other four. Every test scaffolds its input through the CLI too, so the assertion covers the whole documented path rather than a hand-written JSON file:

```ts
it("reaches exploratory mode end to end through the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-mode-exploratory-")); roots.push(root);
  await writeFile(join(root, "environment.json"), JSON.stringify(environment));
  await writeFile(join(root, "charter.json"), JSON.stringify({
    charterId: "CHARTER-CLI", mission: "explore checkout", scope: ["checkout"], roles: ["member"],
    heuristics: ["follow the money"], safetyRules: ["RULE-1"],
    actions: [{ actionId: "ACT-1", target: "/checkout", kind: "navigate", sideEffect: "none", safetyRuleId: "RULE-1" }],
    actionBudget: 5, timeBudgetMinutes: 10, stopConditions: ["budget spent"],
  }));

  const scaffolded = await runCli(["workflow", "scaffold", "--root", root, "--mode", "exploratory",
    "--output", join(root, "exploratory.json"), "--environment-file", join(root, "environment.json"),
    "--charter-file", join(root, "charter.json")], { cwd: root });
  expect(scaffolded.exitCode).toBe(ExitCode.SUCCESS);

  const run = await runCli(["workflow", "run", "--input", join(root, "exploratory.json")], { cwd: root });

  expect(run.stderr).toBe("");
  expect(run.exitCode).toBe(ExitCode.SUCCESS);
  const result = JSON.parse(run.stdout) as WorkflowResult;
  expect(result).toMatchObject({ mode: "exploratory", outcome: "COMPLETED" });
  expect((await registeredArtifacts(root, result.runId)).some((artifact) => artifact.record.type === "exploration-charter")).toBe(true);
});

it("reaches regression mode end to end through the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-mode-regression-")); roots.push(root);
  // `planningOnlyRun` is one line over an existing helper: lift `planBundle` from
  // tests/operations/awaiting-human-input.test.ts (it creates a terminal `plan` run holding the
  // requirement/plan/test-case/obligation set and returns `{ sourceRunId, artifacts }`) and read
  // `.sourceRunId`. It must stay planning-only, because scaffold refuses a bundle source holding
  // anything else (src/cli/workflow.ts:85).
  const planRunId = (await planBundle(root, {})).sourceRunId;
  await writeFile(join(root, "scope.json"), JSON.stringify({
    changes: [{ id: "CHG-1", requirementIds: ["REQ-REG"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }],
    provenance: { kind: "declared-change", reference: "PR-482" },
  }));

  const scaffolded = await runCli(["workflow", "scaffold", "--root", root, "--mode", "regression",
    "--output", join(root, "regression.json"), "--source-root", root, "--source-run-id", planRunId,
    "--change-scope-file", join(root, "scope.json")], { cwd: root });
  expect(scaffolded.exitCode).toBe(ExitCode.SUCCESS);

  const run = await runCli(["workflow", "run", "--input", join(root, "regression.json")], { cwd: root });

  expect(run.stderr).toBe("");
  expect(run.exitCode).toBe(ExitCode.SUCCESS);
  const result = JSON.parse(run.stdout) as WorkflowResult;
  expect(result).toMatchObject({ mode: "regression", outcome: "COMPLETED" });
  const artifacts = await registeredArtifacts(root, result.runId);
  expect(artifacts.some((artifact) => artifact.record.type === "regression-selection")).toBe(true);
  expect(artifacts.filter((artifact) => artifact.record.type === "test-result")).toHaveLength(1);
});
```

The remaining four follow the same three moves — scaffold through the CLI, run through the CLI, assert outcome plus the one artifact type the table names. `execute` and `full` additionally need `--source-root`/`--source-run-id` pointing at a terminal planning run; `retest` needs `--change-scope-file`, `--source-run-id <plan run>` and `--bug-run-id <executed run>`, per the Task 4 fixture note.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/cli/workflow-modes.test.ts`
Expected: the four previously-unreachable modes fail. Paste each failure — these four messages are the evidence MODE-1 existed, and the task report must carry them.

- [ ] **Step 3: Make them pass without touching production code**

Everything needed shipped in Tasks 2–4. If a mode still cannot be reached, STOP and report what is missing rather than adding a flag: an unreachable mode at this point is a finding about Task 4, not a gap in this task.

- [ ] **Step 4: Add the two-lane filtered flow, end to end, through the CLI**

One more test, the phase's headline path:

```
workflow run --input regression.json          -> exit 2, AWAITING_OBSERVED_EXECUTION
execute playwright --root . --run-id <id> --spec-dir <fixture spec dir>
workflow run --input regression-resume.json   -> exit 0, COMPLETED
```

Reuse the tagged-spec fixture `tests/cli/execute-playwright.test.ts` already builds (find it with `grep -n "spec-dir" tests/cli/execute-playwright.test.ts`). Assert: the resumed run drove only the cases the observed suite did not cover, and `validate` reports the run valid.

- [ ] **Step 5: Run the whole CLI suite**

Run: `npx vitest run tests/cli`
Expected: PASS.

- [ ] **Step 6: Run the full gate**

- [ ] **Step 7: Commit**

```bash
git add tests/cli/workflow-modes.test.ts
git commit -m "test: reach all six workflow modes through the CLI, and the two-lane flow

Wart MODE-1's closure condition is reachability asserted where a user stands.
Before this commit exactly two modes ran through `workflow run` in any test;
execute, exploratory, retest and regression were exercised only through
createQaTester, which is why nothing noticed that no CLI path could populate
changeScopeSources.

The last test is the phase's headline path end to end: a regression run pauses at
exit 2, `execute playwright` registers a batch into it, and the resume drives only
the residual and completes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`
- Modify: `skills/shared/references/recovery.md`
- Check: `npm run check:examples` (the repo checks documented examples)

- [ ] **Step 1: Run the documented flow by hand first**

Run the three commands of the two-lane flow against a real demo run and paste the actual commands and outputs into the task report. An example that was never run is a guess — this is the same step Phase 8a's docs task used, and it caught a wrong `jq` assumption then.

- [ ] **Step 2: Write the README section**

A "Filtered runs over both lanes" section containing the three-command flow, and, in prose, the sentences a reader must not miss:

- `workflow run` exits **2** while it waits for the observed suite, and the run is not finished — a CI step must not treat that as a failure to report or as success.
- The selection is one filter: a case the observed suite covered is not driven again, and a case covered by neither lane makes the run invalid.
- Lane 2 is never told what to run. Only tests carrying `[qa:<testCaseId>/<revisionId>/<instanceId>@<surface>]` in their title are observed at all; untagged tests are excluded and printed.
- `changeScope` is authored, and `provenance.kind` is a caller-asserted label nothing verifies — the same caveat Phase 8a applied when it refused to build SARIF locations on it.

- [ ] **Step 3: Extend the recovery reference**

In `skills/shared/references/recovery.md`, add `AWAITING_OBSERVED_EXECUTION`: what it means, that it exits 2, the exact command that clears it, and that resuming without a batch pauses again. Also add the four scaffold inputs from Task 4 with their refusals, so an agent reading only the bundle can reach all six modes.

- [ ] **Step 4: Verify every citation you wrote**

Re-read each file:line reference in the new prose against the code. Phase 8a lost three comments and one doc citation to rot; a citation in a document is a claim like any other.

- [ ] **Step 5: Run the checks**

Run: `npm run check:examples && npm run lint`
Expected: PASS.

- [ ] **Step 6: Run the full gate**

- [ ] **Step 7: Commit**

```bash
git add README.md skills/shared/references/recovery.md
git commit -m "docs: show a filtered run across both lanes, and what exit 2 means there

A run waiting for an observed suite exits 2 and is not finished: a pipeline that
reads that as failure loses the run, and one that reads it as success reports a
gate that was never written.

The example was run end to end before it was written down.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Whole-branch close-out

After Task 6, before merging:

- [ ] Run `superpowers:requesting-code-review` for a whole-branch review with **opus**. Point the reviewer at the question this branch's shape makes load-bearing: **can a run reach a valid, finalized state in which a selected case was executed by neither lane?** Phase 8a's whole-branch review found what four clean per-task reviews could not, because the defect lived above every slice — and this branch weakens three guards that used to be equalities.
- [ ] A second question for the reviewer, because the phase's fixture habit is a known blind spot: **every filter test here uses a selection of one or two cases.** Phase 8a's five Importants all lived at "two observed executions" after every fixture modelled one. Ask what breaks at two batches, at a batch whose entry covers a case the selection excluded, and at a batch registered between the pause and the resume by a DIFFERENT run's export.
- [ ] Verify the gate yourself at branch HEAD — all nine commands from a deleted `dist/` — rather than trusting an implementer's numbers. Two prior sessions caught a controller claiming verification it had not done.
- [ ] Record the outcome in `.superpowers/sdd/progress.md` under a `PHASE 8b` heading: every finding, every deferral, and the reasoning.
- [ ] Close with `superpowers:finishing-a-development-branch`.

## Open questions carried into implementation

1. **Does `reproduce-bug` ever produce an empty output?** It shares `assertResultPostcondition` (`run-workflow.ts:257`). Task 3, Step 4 depends on the answer: if it can, the observed-coverage allowance must be scoped to `execute-browser-test` rather than living in the shared postcondition.
2. **Can a `test-result-batch` registered by an unrelated tool sit in a run the operator did not observe?** Lane 2 opens the run by id (`execute-observed-playwright.ts:348`), so any process with the run id can register one. The pause clears on ANY valid batch. Decide whether that is acceptable (it is the same trust boundary lane 2 already has) and state the answer in `observed-pause.ts` rather than leaving a reader to work it out.
3. **The lane split is NOT recorded in any artifact, and that is settled — do not add it.** Measured while writing this plan: `qa-execution-report.schema.json` is `additionalProperties: false` with `schemaVersion` pinned by `const`, so a lane-split field would bump the const and invalidate every existing run's report on `validate`. The split is derivable by any reader (a triple in a batch entry was observed, a `test-result` was driven), and the spec's Reporting section was corrected to say so. Overloading `excludedNotRun` is refused: those cases were excluded by the selection, not covered by another lane, so the field would state something false.
4. **`hydrateCheckpointState`'s fallback** (`run-workflow.ts:953`) sets `executionCaseIds` from imported test cases when empty. Confirm a resume after the pause does not widen the selection through that path, and pin whichever answer is true with a test.
