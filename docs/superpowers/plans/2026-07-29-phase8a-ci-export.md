# Phase 8a — CI Export (JUnit + SARIF) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a CI pipeline two files it can read — a JUnit XML and a SARIF 2.1.0 report projected from a finalized QA run — each accompanied by a provenance sidecar binding it to the exact release gate it came from.

**Architecture:** Four pure modules under `src/reporting/projections/` (model, JUnit renderer, SARIF renderer, sidecar) plus one impure edge, `src/operations/export-projection.ts`, which opens a finalized run workspace, reads its artifacts, builds the model, renders, and writes. One new CLI command, `qa-skill export`. The projections are derived files: they are never registered as artifacts and nothing is ever written inside `qa-results/<runId>/`.

**Tech Stack:** TypeScript (ESM, Node ≥ 22), vitest, commander, ajv + ajv-formats (already dependencies).

**Spec:** `docs/superpowers/specs/2026-07-29-phase8a-ci-export-design.md`

## Global Constraints

- **No new runtime dependency.** SARIF output is validated in tests with the `ajv` already present.
- **No new exit code.** `src/cli/exit-codes.ts` keeps its six. Export exits `SUCCESS` (0) on success — including when the gate is `NOT_READY` — and `INVALID_INPUT` (3) on refusal, which a thrown `QaSkillsError` already produces via `src/cli/program.ts:305`.
- **`producerVersion` is read from `runtimeVersion`** (`src/installer/manifest.ts:7`), never written as a literal. The repo carries 24 hardcoded literals as filed debt; add none.
- **ESM:** every relative import ends in `.js`.
- **No snapshots.** The repo has zero `toMatchSnapshot`/`toMatchInlineSnapshot`; use explicit assertions.
- **Every test is proven by mutation before it is accepted:** delete or invert the line it covers, watch it go red, restore. A test that passes with the feature removed is not evidence. Report the mutation and its observed failure in the task report.
- **Nothing is written inside `qa-results/<runId>/`.** A finalized run is closed.
- **The full gate is nine commands, run from a deleted `dist/`:**
  ```bash
  rm -rf dist
  npm run generate:types && npm run check:generated && npm run typecheck && npm run lint \
    && npm run check:examples && npm run test:coverage && npm run build \
    && npm run scan:secrets && npm run smoke:package
  ```
  Coverage floor is 90/80/95/90 (statements/branches/functions/lines). A local machine that already has a `dist/` is not the CI condition; CI checks out clean.
- **Commits** are conventional-prefixed and end with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

## Measured facts this plan is built on

These were verified against the code this session. They are not to be re-derived, and not to be assumed away either.

- **A lane-1 attempt's Execution Surface is `"browser"`, structurally.** `src/reporting/release-gate.ts:63-70` hardcodes `executionSurface: "browser"` for `lane === "driven-attempt"`, because the runtime drives lane 1 through a live browser context. This settles the JUnit `classname` question for lane 1.
- **Gate verdict reasons are composed in code from identifiers — with exactly one exception.** `evaluateReleaseGate` (`release-gate.ts:84-107`) interpolates bug ids, obligation ids, and `sharedBlockers` strings. `sharedBlockers` is itself composed at `release-gate.ts:278-288` from `Environment incident <id>`, `Cleanup leak <id>`, `Unmapped change risk <id>`, `Validation diagnostic <diagnostic>` — and `Evidence gap <id> affects <affectedClaim>`. **`affectedClaim` is a free-form `{"type": "string", "minLength": 1}` in `shared/schemas/evidence-gap.schema.json:15`,** so the `NO_SHARED_BLOCKERS` reason can carry authored text. It is the only verdict reason that can, and Task 2 recomposes it under the reduced mode.
- **A lane-2 entry carries no file path.** `ObservedEntry` (`src/observed/report-mapping.ts:19-28`) has no `file`; only `ExcludedSpec` does. The path exists solely in the sanitized report payload, where `src/observed/sanitize-report.ts:67-68` keeps `title`, `file`, `line`, `column` for suites and specs.
- **The repo's Ajv is `Ajv2020` with `strict: true`** (`src/contracts/catalog.ts:71`). The SARIF 2.1.0 schema is draft-07, so the SARIF test constructs its own plain `Ajv` with `strict: false`. Do not touch the shared catalog instance.
- **`WorkflowResult` carries `runId`** (`src/operations/run-workflow.ts:88`) and `workflow run` prints the whole result as JSON (`program.ts:129`), so CI captures the id with `jq`. The CLI deliberately never discovers a "latest" run (`src/cli/workflow.ts:64`) — do not add one.
- **A finalized run is opened with `RunWorkspace.open(root, runId)`** and read with `readRegisteredArtifacts()` (`src/core/run-workspace.ts:137,445`). That reader **already throws `ARTIFACT_BINDING` when the workspace's bindings are invalid** (`run-workspace.ts:448-450`). That is the verification. **Do not add a second gate derivation** — the `VALID_ARTIFACTS` incident is what two disagreeing derivation paths cost.

## File structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/reporting/projections/projection-model.ts` | The single reduction from registered artifacts to `ProjectionModel`; the only place that decides what a projection may see | 1, 2 |
| `src/reporting/projections/junit.ts` | `ProjectionModel → string` (XML) | 3 |
| `src/reporting/projections/sarif.ts` | `ProjectionModel → string` (SARIF 2.1.0 JSON) | 4 |
| `src/reporting/projections/spec-locations.ts` | Join a lane-2 entry to its spec `file`/`line` through sanitized evidence | 5 |
| `src/reporting/projections/sidecar.ts` | `ProjectionModel + bytes → string` (provenance JSON) | 6 |
| `src/operations/export-projection.ts` | The impure edge: open, read, build, render, write | 6 |
| `src/cli/program.ts` | The `export` command | 6 |
| `fixtures/sarif/sarif-2.1.0-schema.json` | Vendored official schema, test-only | 4 |
| `README.md`, `skills/shared/references/recovery.md` | CI example and exit codes | 7 |

---

### Task 1: Projection model — gate and attempts

**Files:**
- Create: `src/reporting/projections/projection-model.ts`
- Test: `tests/reporting/projections/projection-model.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ProjectionArtifact`, `AttemptRow`, `FindingRow`, `ProjectionModel`, `buildProjectionModel(input)`. Tasks 2–6 all consume these exact names.

- [ ] **Step 1: Write the failing test**

Create `tests/reporting/projections/projection-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildProjectionModel, type ProjectionArtifact } from "../../../src/reporting/projections/projection-model.js";

const gateArtifact: ProjectionArtifact = {
  record: { id: "gate-1", sha256: "a".repeat(64), type: "release-gate" },
  value: {
    artifactType: "release-gate", recommendation: "NOT_READY", protectedEnvironment: false,
    sourceArtifacts: [{ id: "tr-1", sha256: "b".repeat(64), type: "test-result" }],
    ruleInputs: { artifactsValid: true, coverage: { requiredMissing: ["COV-1"], optionalGaps: [], requiredHighRisk: [] }, bugs: [], sharedBlockers: [] },
    verdicts: [{ rule: "REQUIRED_COVERAGE_COMPLETE", passed: false, reason: "Required coverage missing: COV-1." }],
  },
};

const drivenAttempt: ProjectionArtifact = {
  record: { id: "tr-1", sha256: "b".repeat(64), type: "test-result" },
  value: {
    artifactType: "test-result", attemptId: "ATT-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1",
    status: "FAILED", failureClassification: "PRODUCT_DEFECT", observedEngine: "chromium",
    steps: [{ stepId: "S1", status: "PASSED", durationMs: 1200 }, { stepId: "S2", status: "FAILED", durationMs: 300 }],
  },
};

const batch: ProjectionArtifact = {
  record: { id: "batch-1", sha256: "c".repeat(64), type: "test-result-batch" },
  value: {
    artifactType: "test-result-batch", executionId: "EX-1", commitSha: "d".repeat(40), specTreeSha256: "e".repeat(64),
    entries: [
      { entryId: "E-1", testCaseId: "TC-2", testCaseRevisionId: "REV-2", testCaseInstanceId: "INST-2", status: "PASSED", failureClassification: "NONE", executionSurface: "api", steps: [{ stepId: "S1", status: "PASSED", durationMs: 500 }] },
      { entryId: "E-2", testCaseId: "TC-3", testCaseRevisionId: "REV-3", testCaseInstanceId: "INST-3", status: "NOT_RUN", failureClassification: "NONE", executionSurface: "unit", steps: [{ stepId: "S1", status: "NOT_RUN", durationMs: 0 }] },
    ],
  },
};

const base = { runId: "RUN-1", producerVersion: "0.3.0", generatedAt: "2026-07-29T00:00:00.000Z" };

describe("buildProjectionModel", () => {
  it("refuses a run with no release gate, because an unfinalized run has nothing to project", () => {
    expect(() => buildProjectionModel({ ...base, artifacts: [drivenAttempt] }))
      .toThrowError(/release gate/i);
  });

  it("carries the persisted gate verbatim rather than re-deriving it", () => {
    const model = buildProjectionModel({ ...base, artifacts: [gateArtifact] });
    expect(model.gate).toMatchObject({ artifactId: "gate-1", sha256: "a".repeat(64), recommendation: "NOT_READY" });
    expect(model.gate.verdicts).toEqual([{ rule: "REQUIRED_COVERAGE_COMPLETE", passed: false, reason: "Required coverage missing: COV-1." }]);
    expect(model.sourceArtifacts).toEqual([{ id: "tr-1", sha256: "b".repeat(64), type: "test-result" }]);
  });

  it("reads a lane-1 attempt as the browser surface and sums its measured step durations", () => {
    const model = buildProjectionModel({ ...base, artifacts: [gateArtifact, drivenAttempt] });
    expect(model.attempts).toEqual([{
      lane: "driven-attempt", id: "ATT-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1",
      status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "browser", durationMs: 1500,
    }]);
  });

  it("reads each lane-2 entry as its own row on the surface the entry itself declares", () => {
    const model = buildProjectionModel({ ...base, artifacts: [gateArtifact, batch] });
    expect(model.attempts.map((row) => [row.id, row.executionSurface, row.status, row.durationMs]))
      .toEqual([["E-1", "api", "PASSED", 500], ["E-2", "unit", "NOT_RUN", 0]]);
  });

  it("carries the git anchor when an observed execution exists, and omits it when none does", () => {
    expect(buildProjectionModel({ ...base, artifacts: [gateArtifact, batch] }).anchor)
      .toEqual({ commitSha: "d".repeat(40), specTreeSha256: "e".repeat(64) });
    expect(buildProjectionModel({ ...base, artifacts: [gateArtifact, drivenAttempt] }).anchor).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/reporting/projections/projection-model.test.ts`
Expected: FAIL — cannot resolve `../../../src/reporting/projections/projection-model.js`.

- [ ] **Step 3: Write the implementation**

Create `src/reporting/projections/projection-model.ts`:

```ts
import { QaSkillsError } from "../../core/errors.js";
import { isRecord } from "../../core/values.js";

/** The artifact shape a projection reads. Declared structurally, not imported from `RunWorkspace`, for
 *  the same reason `release-gate.ts` declares `GateWorkspaceArtifact` locally: these modules are pure
 *  reducers over already-read records and must not acquire a dependency on the reader. */
export type ProjectionArtifact = Readonly<{
  record: Readonly<{ id: string; sha256: string; type: string; provenance?: string }>;
  value: Readonly<Record<string, unknown>>;
}>;

export type ProjectionLocation = Readonly<{ file: string; line?: number }>;

export type AttemptRow = Readonly<{
  lane: "driven-attempt" | "observed-entry";
  id: string;
  testCaseId: string;
  /** Carried from the start because Task 5's location join keys on the FULL four-part identity.
   *  Keying on `testCaseId` alone would join two entries that differ only by revision. */
  testCaseRevisionId: string;
  testCaseInstanceId: string;
  status: string;
  failureClassification: string;
  executionSurface: string;
  durationMs: number;
  location?: ProjectionLocation;
}>;

export type FindingRow = Readonly<{ ruleId: string; level: "error" | "warning"; id: string; message: string }>;

export type ProjectionModel = Readonly<{
  runId: string;
  producerVersion: string;
  generatedAt: string;
  reduced: boolean;
  gate: Readonly<{ artifactId: string; sha256: string; recommendation: string; verdicts: readonly Readonly<{ rule: string; passed: boolean; reason: string }>[] }>;
  attempts: readonly AttemptRow[];
  findings: readonly FindingRow[];
  anchor?: Readonly<{ commitSha: string; specTreeSha256: string }>;
  sourceArtifacts: readonly Readonly<{ id: string; sha256: string; type: string }>[];
}>;

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const arr = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** Sum of MEASURED step durations, for both lanes. A lane-2 entry has no timestamps of its own — only
 *  the batch has them — so reading `startedAt`/`finishedAt` would make lane 1 and lane 2 report
 *  different things under one column. Step durations are what both lanes actually measured. */
function durationOf(value: Readonly<Record<string, unknown>>): number {
  return arr(value.steps).filter(isRecord).reduce((total, step) => total + (typeof step.durationMs === "number" ? step.durationMs : 0), 0);
}

export function buildProjectionModel(input: Readonly<{
  runId: string; producerVersion: string; generatedAt: string; artifacts: readonly ProjectionArtifact[];
}>): ProjectionModel {
  const gateArtifact = input.artifacts.find((artifact) => artifact.record.type === "release-gate");
  if (!gateArtifact) throw new QaSkillsError("This run has no release gate: only a finalized run can be projected", "INVALID_ARTIFACT");

  const verdicts = arr(gateArtifact.value.verdicts).filter(isRecord).flatMap((verdict) => {
    const rule = str(verdict.rule);
    const reason = str(verdict.reason);
    return rule === undefined || reason === undefined || typeof verdict.passed !== "boolean" ? [] : [{ rule, passed: verdict.passed, reason }];
  });
  const sourceArtifacts = arr(gateArtifact.value.sourceArtifacts).filter(isRecord).flatMap((entry) => {
    const id = str(entry.id); const sha256 = str(entry.sha256); const type = str(entry.type);
    return id === undefined || sha256 === undefined || type === undefined ? [] : [{ id, sha256, type }];
  });

  // Lane 1's Execution Surface is structural, not declared: the runtime drives every `test-result`
  // through a live browser context, which is why `release-gate.ts:63-70` hardcodes "browser" for the
  // driven lane too. Reading a field the `test-result` schema does not have would invent a value.
  const driven: AttemptRow[] = input.artifacts.filter((artifact) => artifact.record.type === "test-result").flatMap((artifact) => {
    const id = str(artifact.value.attemptId); const testCaseId = str(artifact.value.testCaseId);
    const testCaseRevisionId = str(artifact.value.testCaseRevisionId);
    const testCaseInstanceId = str(artifact.value.testCaseInstanceId); const status = str(artifact.value.status);
    const failureClassification = str(artifact.value.failureClassification);
    return id === undefined || testCaseId === undefined || testCaseRevisionId === undefined || testCaseInstanceId === undefined || status === undefined || failureClassification === undefined
      ? []
      : [{ lane: "driven-attempt" as const, id, testCaseId, testCaseRevisionId, testCaseInstanceId, status, failureClassification, executionSurface: "browser", durationMs: durationOf(artifact.value) }];
  });

  const batches = input.artifacts.filter((artifact) => artifact.record.type === "test-result-batch");
  const observed: AttemptRow[] = batches.flatMap((artifact) => arr(artifact.value.entries).filter(isRecord).flatMap((entry) => {
    const id = str(entry.entryId); const testCaseId = str(entry.testCaseId);
    const testCaseRevisionId = str(entry.testCaseRevisionId);
    const testCaseInstanceId = str(entry.testCaseInstanceId); const status = str(entry.status);
    const failureClassification = str(entry.failureClassification); const executionSurface = str(entry.executionSurface);
    return id === undefined || testCaseId === undefined || testCaseRevisionId === undefined || testCaseInstanceId === undefined || status === undefined || failureClassification === undefined || executionSurface === undefined
      ? []
      : [{ lane: "observed-entry" as const, id, testCaseId, testCaseRevisionId, testCaseInstanceId, status, failureClassification, executionSurface, durationMs: durationOf(entry) }];
  }));

  const anchorSource = batches[0]?.value;
  const commitSha = anchorSource === undefined ? undefined : str(anchorSource.commitSha);
  const specTreeSha256 = anchorSource === undefined ? undefined : str(anchorSource.specTreeSha256);

  return {
    runId: input.runId,
    producerVersion: input.producerVersion,
    generatedAt: input.generatedAt,
    reduced: gateArtifact.value.protectedEnvironment === true,
    gate: { artifactId: gateArtifact.record.id, sha256: gateArtifact.record.sha256, recommendation: str(gateArtifact.value.recommendation) ?? "NOT_READY", verdicts },
    attempts: [...driven, ...observed],
    findings: [],
    ...(commitSha === undefined || specTreeSha256 === undefined ? {} : { anchor: { commitSha, specTreeSha256 } }),
    sourceArtifacts,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/reporting/projections/projection-model.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove each test by mutation**

For each of the five tests, apply the mutation, observe the red, restore:

| Test | Mutation | Expected red |
| --- | --- | --- |
| refuses a run with no release gate | delete the `if (!gateArtifact) throw` line | `Cannot read properties of undefined` instead of the refusal, or a passing build with no throw |
| carries the persisted gate verbatim | return `verdicts: []` unconditionally | verdict equality fails |
| lane-1 browser surface + summed duration | change `executionSurface: "browser"` to `"unit"`, then separately change `durationOf` to read `value.startedAt` | surface mismatch; then `durationMs` 1500 → NaN/0 |
| lane-2 rows | drop the `.flatMap` over `entries` and return one row per batch | two rows collapse to one |
| anchor present/absent | always return the anchor, using `""` fallbacks | the omission case fails |

Record each observed failure message in the task report. A mutation that leaves the suite green means the test is not pinning what it claims.

- [ ] **Step 6: Run the full gate**

Run:
```bash
rm -rf dist && npm run generate:types && npm run check:generated && npm run typecheck && npm run lint \
  && npm run check:examples && npm run test:coverage && npm run build && npm run scan:secrets && npm run smoke:package
```
Expected: all green, coverage at or above 90/80/95/90.

- [ ] **Step 7: Commit**

```bash
git add src/reporting/projections/projection-model.ts tests/reporting/projections/projection-model.test.ts
git commit -m "feat: reduce a finalized run to a projection model over both lanes

A projection reads the PERSISTED release gate rather than re-deriving it. Two
derivation paths that can disagree is what the VALID_ARTIFACTS incident cost:
a persisted gate that mismatches its own re-derivation is flagged
ARTIFACT_BINDING on every subsequent read, unrecoverably.

Lane 1's Execution Surface is hardcoded \"browser\" because it is structural --
release-gate.ts:63-70 does the same for the driven lane, since the runtime
drives every test-result through a live browser context. Reading a field the
test-result schema does not have would invent a value.

Duration is the sum of measured step durations for BOTH lanes. A lane-2 entry
has no timestamps of its own -- only the batch has them -- so reading
startedAt/finishedAt would put two different measurements under one column.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Findings rows and the reduced mode

**Files:**
- Modify: `src/reporting/projections/projection-model.ts`
- Test: `tests/reporting/projections/projection-model.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `buildProjectionModel`, `FindingRow`, `ProjectionModel` from Task 1.
- Produces: populated `model.findings`; `reducedVerdictReason(verdict, ruleInputs)`; the exported constant `identifierOnlyGateRules`, which Task 3 and Task 4 do not import but the drift test in this task pins.

- [ ] **Step 1: Write the failing test**

Append to `tests/reporting/projections/projection-model.test.ts`:

```ts
import { evaluateReleaseGate } from "../../../src/reporting/release-gate.js";
import { identifierOnlyGateRules } from "../../../src/reporting/projections/projection-model.js";

const withFindings = (protectedEnvironment: boolean): ProjectionArtifact => ({
  record: { id: "gate-2", sha256: "a".repeat(64), type: "release-gate" },
  value: {
    artifactType: "release-gate", recommendation: "NOT_READY", protectedEnvironment,
    sourceArtifacts: [],
    ruleInputs: {
      artifactsValid: true,
      coverage: { requiredMissing: ["COV-1"], optionalGaps: ["COV-2"], requiredHighRisk: [] },
      bugs: [{ bugId: "BUG-1", triageStatus: "TRIAGED", severity: "Critical", open: true },
             { bugId: "BUG-2", triageStatus: "TRIAGED", severity: "Minor", open: true },
             { bugId: "BUG-3", triageStatus: "TRIAGED", severity: "Major", open: false }],
      sharedBlockers: ["Evidence gap GAP-1 affects the checkout total shown to a signed-in buyer"],
    },
    verdicts: [
      { rule: "NO_SHARED_BLOCKERS", passed: false, reason: "Shared blockers: Evidence gap GAP-1 affects the checkout total shown to a signed-in buyer." },
      { rule: "REQUIRED_COVERAGE_COMPLETE", passed: false, reason: "Required coverage missing: COV-1." },
    ],
  },
});

const gapArtifact: ProjectionArtifact = {
  record: { id: "gap-1", sha256: "f".repeat(64), type: "evidence-gap" },
  value: { artifactType: "evidence-gap", evidenceGapId: "GAP-1", reason: "Trace retention refused by the environment profile", affectedClaim: "the checkout total shown to a signed-in buyer" },
};

describe("projection findings", () => {
  it("emits one finding per open bug, unmet requirement, optional gap and evidence gap, and none for a closed bug", () => {
    const model = buildProjectionModel({ ...base, artifacts: [withFindings(false), gapArtifact] });
    expect(model.findings.map((finding) => [finding.ruleId, finding.level, finding.id])).toEqual([
      ["open-bug", "error", "BUG-1"],
      ["open-bug", "warning", "BUG-2"],
      ["required-coverage-unmet", "error", "COV-1"],
      ["optional-coverage-gap", "warning", "COV-2"],
      ["evidence-gap", "warning", "GAP-1"],
    ]);
  });

  it("keeps authored text out of a reduced projection, in findings AND in the one verdict reason that can carry it", () => {
    const model = buildProjectionModel({ ...base, artifacts: [withFindings(true), gapArtifact] });
    expect(model.reduced).toBe(true);
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain("checkout total shown to a signed-in buyer");
    expect(serialized).not.toContain("Trace retention refused");
    expect(model.findings.find((finding) => finding.id === "GAP-1")?.message).toBe("evidence gap GAP-1");
    expect(model.gate.verdicts.find((verdict) => verdict.rule === "NO_SHARED_BLOCKERS")?.reason).toBe("Shared blockers: 1.");
    // Identifier-only reasons survive reduction: they name what is wrong without quoting anyone.
    expect(model.gate.verdicts.find((verdict) => verdict.rule === "REQUIRED_COVERAGE_COMPLETE")?.reason).toBe("Required coverage missing: COV-1.");
  });

  it("pins the set of gate rules whose reason is identifier-only, so a new rule cannot silently join it", () => {
    const everyRule = evaluateReleaseGate({
      artifactsValid: true, coverage: { requiredMissing: [], optionalGaps: [], requiredHighRisk: [] }, bugs: [], sharedBlockers: [],
    }).verdicts.map((verdict) => verdict.rule);
    expect([...everyRule].sort()).toEqual([...identifierOnlyGateRules, "NO_SHARED_BLOCKERS"].sort());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/reporting/projections/projection-model.test.ts -t "projection findings"`
Expected: FAIL — `identifierOnlyGateRules` is not exported; `model.findings` is `[]`.

- [ ] **Step 3: Write the implementation**

In `src/reporting/projections/projection-model.ts`, add above `buildProjectionModel`:

```ts
/** Every gate rule whose `reason` is composed in code from IDENTIFIERS ONLY — bug ids, obligation ids —
 *  and therefore survives a reduced projection unchanged.
 *
 *  `NO_SHARED_BLOCKERS` is deliberately absent. Its reason interpolates `sharedBlockers`, one of whose
 *  five sources is `Evidence gap <id> affects <affectedClaim>` (release-gate.ts:278-288), and
 *  `affectedClaim` is a free-form string in evidence-gap.schema.json:15 — authored text, not an
 *  identifier. It is the ONLY reason that can carry authored text, and the reduced mode recomposes it.
 *
 *  The drift test in tests/reporting/projections/projection-model.test.ts pins this list against the
 *  rules `evaluateReleaseGate` actually emits, so a seventh rule cannot silently inherit "safe". */
export const identifierOnlyGateRules = [
  "VALID_ARTIFACTS",
  "NO_OPEN_BLOCKER_OR_CRITICAL",
  "NO_UNTRIAGED_PRODUCT_BUG",
  "REQUIRED_HIGH_RISK_PASSED",
  "REQUIRED_COVERAGE_COMPLETE",
  "NO_OPEN_PRODUCT_DEFECT_FOR_READY",
] as const;

/** A reduced reason states the same verdict with a count instead of a quotation. */
export function reducedVerdictReason(verdict: Readonly<{ rule: string; reason: string }>, ruleInputs: Readonly<Record<string, unknown>>): string {
  if ((identifierOnlyGateRules as readonly string[]).includes(verdict.rule)) return verdict.reason;
  return `Shared blockers: ${arr(ruleInputs.sharedBlockers).length}.`;
}
```

Inside `buildProjectionModel`, after `sourceArtifacts` is computed:

```ts
  const reduced = gateArtifact.value.protectedEnvironment === true;
  const ruleInputs = isRecord(gateArtifact.value.ruleInputs) ? gateArtifact.value.ruleInputs : {};
  const coverage = isRecord(ruleInputs.coverage) ? ruleInputs.coverage : {};
  const bugs = arr(ruleInputs.bugs).filter(isRecord).filter((bug) => bug.open === true);

  const findings: FindingRow[] = [
    ...bugs.flatMap((bug) => {
      const id = str(bug.bugId);
      if (id === undefined) return [];
      const severity = str(bug.severity) ?? "Unspecified";
      const level = severity === "Blocker" || severity === "Critical" ? "error" as const : "warning" as const;
      return [{ ruleId: "open-bug", level, id, message: `open bug ${id}, severity ${severity}` }];
    }),
    ...arr(coverage.requiredMissing).flatMap((item) => {
      const id = str(item);
      return id === undefined ? [] : [{ ruleId: "required-coverage-unmet", level: "error" as const, id, message: `required coverage obligation ${id} is unmet` }];
    }),
    ...arr(coverage.optionalGaps).flatMap((item) => {
      const id = str(item);
      return id === undefined ? [] : [{ ruleId: "optional-coverage-gap", level: "warning" as const, id, message: `optional coverage obligation ${id} is unmet` }];
    }),
    ...input.artifacts.filter((artifact) => artifact.record.type === "evidence-gap").flatMap((artifact) => {
      const id = str(artifact.value.evidenceGapId);
      if (id === undefined) return [];
      // The gap's own `reason` and `affectedClaim` are authored text; under reduction the message is
      // composed from the identifier alone, which still names the gap without quoting anyone.
      const message = reduced ? `evidence gap ${id}` : `evidence gap ${id}: ${str(artifact.value.reason) ?? "no reason recorded"}`;
      return [{ ruleId: "evidence-gap", level: "warning" as const, id, message }];
    }),
  ];
```

Then use `reduced ? verdicts.map((verdict) => ({ ...verdict, reason: reducedVerdictReason(verdict, ruleInputs) })) : verdicts` for `gate.verdicts`, and return `findings` instead of `[]`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/reporting/projections/projection-model.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove each test by mutation**

| Test | Mutation | Expected red |
| --- | --- | --- |
| findings per source | drop the `.filter((bug) => bug.open === true)` | the closed `BUG-3` appears, list equality fails |
| reduced mode | return `verdict.reason` unconditionally from `reducedVerdictReason` | the serialized model contains `checkout total shown to a signed-in buyer` |
| reduced mode | drop the `reduced ?` branch in the evidence-gap message | the serialized model contains `Trace retention refused` |
| drift pin | add `"NO_SHARED_BLOCKERS"` to `identifierOnlyGateRules` | the drift test fails on the duplicate, and the reduced-mode test fails on the leak — proving the pin and the behaviour are wired to the same list |

- [ ] **Step 6: Run the full gate** (same nine commands as Task 1, Step 6)

- [ ] **Step 7: Commit**

```bash
git add src/reporting/projections/projection-model.ts tests/reporting/projections/projection-model.test.ts
git commit -m "feat: project findings, and keep authored text out of a protected run

Under protectedEnvironment a projection leaves the artifact system for a CI
service, so it carries identifiers, statuses, severities and counts -- never
text an agent authored or telemetry captured.

One gate verdict reason can carry authored text and the rest cannot.
NO_SHARED_BLOCKERS interpolates sharedBlockers, one of whose five sources is
'Evidence gap <id> affects <affectedClaim>', and affectedClaim is a free-form
string in evidence-gap.schema.json:15. It is recomposed as a count; the other
six reasons are identifier-only and survive unchanged.

The identifier-only list is pinned against the rules evaluateReleaseGate
actually emits, so a seventh rule cannot silently inherit 'safe'.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: JUnit renderer

**Files:**
- Create: `src/reporting/projections/junit.ts`
- Test: `tests/reporting/projections/junit.test.ts`

**Interfaces:**
- Consumes: `ProjectionModel`, `AttemptRow` from Task 1.
- Produces: `renderJUnit(model: ProjectionModel): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/reporting/projections/junit.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { renderJUnit } from "../../../src/reporting/projections/junit.js";
import type { AttemptRow, ProjectionModel } from "../../../src/reporting/projections/projection-model.js";

const attempt = (over: Partial<AttemptRow>): AttemptRow => ({
  lane: "observed-entry", id: "E-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1",
  status: "PASSED", failureClassification: "NONE", executionSurface: "api", durationMs: 1500, ...over,
});

const model = (over: Partial<ProjectionModel> = {}): ProjectionModel => ({
  runId: "RUN-1", producerVersion: "0.3.0", generatedAt: "2026-07-29T00:00:00.000Z", reduced: false,
  gate: { artifactId: "gate-1", sha256: "a".repeat(64), recommendation: "NOT_READY", verdicts: [
    { rule: "VALID_ARTIFACTS", passed: true, reason: "All registered artifacts are valid." },
    { rule: "REQUIRED_COVERAGE_COMPLETE", passed: false, reason: "Required coverage missing: COV-1." },
  ] },
  attempts: [], findings: [], sourceArtifacts: [], ...over,
});

describe("renderJUnit", () => {
  it("emits one testcase per gate verdict, failing exactly the verdicts that did not pass", () => {
    const xml = renderJUnit(model());
    expect(xml).toContain(`<testsuite name="qa-skills.gate" tests="2" failures="1" errors="0" skipped="0">`);
    expect(xml).toContain(`<testcase name="VALID_ARTIFACTS" classname="gate" time="0"/>`);
    expect(xml).toContain(`<failure message="Required coverage missing: COV-1."/>`);
  });

  it("maps every attempt status to its JUnit element, and counts the suite from the rows", () => {
    const xml = renderJUnit(model({ attempts: [
      attempt({ id: "E-1", status: "PASSED" }),
      attempt({ id: "E-2", status: "FAILED", failureClassification: "PRODUCT_DEFECT" }),
      attempt({ id: "E-3", status: "BLOCKED" }),
      attempt({ id: "E-4", status: "INCONCLUSIVE" }),
      attempt({ id: "E-5", status: "NOT_RUN", durationMs: 0 }),
    ] }));
    expect(xml).toContain(`<testsuite name="qa-skills.attempts" tests="5" failures="1" errors="2" skipped="1">`);
    expect(xml).toContain(`<failure message="failureClassification=PRODUCT_DEFECT"/>`);
    expect(xml).toContain(`<error message="status=BLOCKED"/>`);
    expect(xml).toContain(`<error message="status=INCONCLUSIVE"/>`);
    expect(xml).toContain(`<skipped/>`);
  });

  it("reports a lane-1 attempt on the browser surface and converts measured milliseconds to seconds", () => {
    const xml = renderJUnit(model({ attempts: [attempt({ lane: "driven-attempt", id: "ATT-1", executionSurface: "browser", durationMs: 1500 })] }));
    expect(xml).toContain(`<testcase name="TC-1 INST-1" classname="browser" time="1.5"/>`);
  });

  it("escapes every XML metacharacter, so a reason or a test case id cannot break the document", () => {
    const xml = renderJUnit(model({
      gate: { artifactId: "g", sha256: "a".repeat(64), recommendation: "NOT_READY", verdicts: [
        { rule: "NO_SHARED_BLOCKERS", passed: false, reason: `a & b < c > d " e ' f` },
      ] },
      attempts: [attempt({ testCaseId: `TC<1>`, testCaseInstanceId: `I"1'` })],
    }));
    expect(xml).toContain(`<failure message="a &amp; b &lt; c &gt; d &quot; e &apos; f"/>`);
    expect(xml).toContain(`<testcase name="TC&lt;1&gt; I&quot;1&apos;"`);
    expect(xml).not.toMatch(/message="[^"]*[<>&](?!(amp|lt|gt|quot|apos);)/);
  });

  it("emits no findings suite: a bug is not a test case", () => {
    const xml = renderJUnit(model({ findings: [{ ruleId: "open-bug", level: "error", id: "BUG-1", message: "open bug BUG-1, severity Critical" }] }));
    expect(xml).not.toContain("BUG-1");
    expect(xml.match(/<testsuite /g)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/reporting/projections/junit.test.ts`
Expected: FAIL — cannot resolve `junit.js`.

- [ ] **Step 3: Write the implementation**

Create `src/reporting/projections/junit.ts`:

```ts
import type { AttemptRow, ProjectionModel } from "./projection-model.js";

/** Attribute-safe escaping. `'` and `"` are escaped as well as the three structural characters,
 *  because every value this renderer emits lands inside a double-quoted attribute. */
function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    character === "&" ? "&amp;" : character === "<" ? "&lt;" : character === ">" ? "&gt;" : character === '"' ? "&quot;" : "&apos;");
}

const seconds = (milliseconds: number): string => String(Math.round(milliseconds) / 1000);

type Child = Readonly<{ kind: "failure" | "error" | "skipped"; message?: string }>;

/** Status → JUnit element. FAILED is a failure; BLOCKED and INCONCLUSIVE are errors, because neither
 *  is a verdict about the product — the attempt did not reach one. NOT_RUN is skipped. */
function childOf(row: AttemptRow): Child | undefined {
  if (row.status === "FAILED") return { kind: "failure", message: `failureClassification=${row.failureClassification}` };
  if (row.status === "BLOCKED" || row.status === "INCONCLUSIVE") return { kind: "error", message: `status=${row.status}` };
  if (row.status === "NOT_RUN") return { kind: "skipped" };
  return undefined;
}

function renderCase(name: string, classname: string, time: string, child: Child | undefined): string {
  const open = `    <testcase name="${escapeXml(name)}" classname="${escapeXml(classname)}" time="${time}"`;
  if (child === undefined) return `${open}/>`;
  const inner = child.message === undefined ? `      <${child.kind}/>` : `      <${child.kind} message="${escapeXml(child.message)}"/>`;
  return `${open}>\n${inner}\n    </testcase>`;
}

function renderSuite(name: string, cases: readonly string[], counts: Readonly<{ failures: number; errors: number; skipped: number }>): string {
  return [
    `  <testsuite name="${name}" tests="${cases.length}" failures="${counts.failures}" errors="${counts.errors}" skipped="${counts.skipped}">`,
    ...cases,
    `  </testsuite>`,
  ].join("\n");
}

/** Two suites, one file. `findings` is deliberately NOT rendered: a bug or an unmet coverage obligation
 *  is not a test case, and a third suite naming them as such would overclaim in the format most likely
 *  to be read by a machine. SARIF carries them instead. */
export function renderJUnit(model: ProjectionModel): string {
  const gateCases = model.gate.verdicts.map((verdict) =>
    renderCase(verdict.rule, "gate", "0", verdict.passed ? undefined : { kind: "failure", message: verdict.reason }));
  const gateFailures = model.gate.verdicts.filter((verdict) => !verdict.passed).length;

  const children = model.attempts.map((row) => ({ row, child: childOf(row) }));
  const attemptCases = children.map(({ row, child }) => renderCase(`${row.testCaseId} ${row.testCaseInstanceId}`, row.executionSurface, seconds(row.durationMs), child));
  const count = (kind: Child["kind"]) => children.filter((entry) => entry.child?.kind === kind).length;

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="qa-skills" runId="${escapeXml(model.runId)}">`,
    renderSuite("qa-skills.gate", gateCases, { failures: gateFailures, errors: 0, skipped: 0 }),
    renderSuite("qa-skills.attempts", attemptCases, { failures: count("failure"), errors: count("error"), skipped: count("skipped") }),
    `</testsuites>`,
    ``,
  ].join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/reporting/projections/junit.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove each test by mutation**

| Test | Mutation | Expected red |
| --- | --- | --- |
| gate suite | render every verdict as passing | `failures="1"` becomes `failures="0"` |
| status mapping | map `INCONCLUSIVE` to `undefined` | `errors="2"` becomes `errors="1"` |
| duration | return `String(milliseconds)` from `seconds` | `time="1.5"` becomes `time="1500"` |
| escaping | make `escapeXml` the identity | the raw `&` assertion fails and the regex guard fires |
| no findings suite | render a third suite from `findings` | the `BUG-1` absence assertion fails and the suite count is 3 |

- [ ] **Step 6: Run the full gate** (same nine commands)

- [ ] **Step 7: Commit**

```bash
git add src/reporting/projections/junit.ts tests/reporting/projections/junit.test.ts
git commit -m "feat: render a JUnit projection carrying gate verdicts and attempts

Two suites in one file. A gate-only file hides which tests ran; an
attempts-only file hides a NOT_READY caused by unmet coverage, and a CI
operator needs both.

BLOCKED and INCONCLUSIVE are errors rather than failures: neither is a verdict
about the product, the attempt never reached one.

No third suite for findings. A bug is not a test case, and naming it one in
the format most likely to be machine-read would overclaim -- SARIF carries
findings instead.

Every emitted value is attribute-escaped, including the apostrophe, since all
of them land inside double-quoted attributes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: SARIF renderer, validated against the official schema

**Files:**
- Create: `src/reporting/projections/sarif.ts`
- Create: `fixtures/sarif/sarif-2.1.0-schema.json` (vendored, test-only)
- Test: `tests/reporting/projections/sarif.test.ts`

**Interfaces:**
- Consumes: `ProjectionModel`, `FindingRow` from Tasks 1–2.
- Produces: `renderSarif(model: ProjectionModel): string`.

- [ ] **Step 1: Vendor the schema, and stop if it is oversized**

```bash
mkdir -p fixtures/sarif
curl -sSL https://json.schemastore.org/sarif-2.1.0.json -o fixtures/sarif/sarif-2.1.0-schema.json
ls -l fixtures/sarif/sarif-2.1.0-schema.json
grep -o '"\$schema": *"[^"]*"' fixtures/sarif/sarif-2.1.0-schema.json | head -1
```

Record the byte size and the declared `$schema` draft in the task report. **If the file exceeds 2 MB, stop and report rather than committing it** — that is an escalation to the controller, not a decision to take alone. Also record the schema's licence line if it carries one.

- [ ] **Step 2: Write the failing test**

Create `tests/reporting/projections/sarif.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { renderSarif } from "../../../src/reporting/projections/sarif.js";
import type { ProjectionModel } from "../../../src/reporting/projections/projection-model.js";

// The shared catalog instance is Ajv2020 with strict:true (src/contracts/catalog.ts:71). The SARIF
// schema is draft-07, so this test builds its own plain Ajv rather than reconfiguring the catalog.
const require = createRequire(import.meta.url);
const Ajv = (require("ajv") as { default: new (options: object) => { compile: (schema: object) => (data: unknown) => boolean } }).default;
const addFormats = (require("ajv-formats") as { default: (instance: unknown) => void }).default;

const model = (over: Partial<ProjectionModel> = {}): ProjectionModel => ({
  runId: "RUN-1", producerVersion: "0.3.0", generatedAt: "2026-07-29T00:00:00.000Z", reduced: false,
  gate: { artifactId: "gate-1", sha256: "a".repeat(64), recommendation: "NOT_READY", verdicts: [
    { rule: "VALID_ARTIFACTS", passed: true, reason: "All registered artifacts are valid." },
    { rule: "REQUIRED_COVERAGE_COMPLETE", passed: false, reason: "Required coverage missing: COV-1." },
  ] },
  attempts: [], findings: [], sourceArtifacts: [], ...over,
});

describe("renderSarif", () => {
  it("validates against the official SARIF 2.1.0 schema", async () => {
    const schema: object = JSON.parse(await readFile(new URL("../../../fixtures/sarif/sarif-2.1.0-schema.json", import.meta.url), "utf8"));
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    expect(ajv.compile(schema)(JSON.parse(renderSarif(model({
      findings: [{ ruleId: "open-bug", level: "error", id: "BUG-1", message: "open bug BUG-1, severity Critical" }],
      attempts: [{ lane: "observed-entry", id: "E-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1", status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "api", durationMs: 5, location: { file: "specs/checkout.spec.ts", line: 42 } }],
      anchor: { commitSha: "d".repeat(40), specTreeSha256: "e".repeat(64) },
    }))))).toBe(true);
  });

  it("emits one result per failing verdict and per finding, and none for a passing verdict", () => {
    const sarif = JSON.parse(renderSarif(model({ findings: [{ ruleId: "open-bug", level: "warning", id: "BUG-2", message: "open bug BUG-2, severity Minor" }] })));
    expect(sarif.runs[0].results.map((result: { ruleId: string; level: string }) => [result.ruleId, result.level]))
      .toEqual([["REQUIRED_COVERAGE_COMPLETE", "error"], ["open-bug", "warning"]]);
  });

  it("attaches a location only to an observed failure that has one, and never invents one", () => {
    const sarif = JSON.parse(renderSarif(model({
      attempts: [
        { lane: "observed-entry", id: "E-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1", status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "api", durationMs: 5, location: { file: "specs/checkout.spec.ts", line: 42 } },
        { lane: "observed-entry", id: "E-2", testCaseId: "TC-2", testCaseRevisionId: "REV-2", testCaseInstanceId: "INST-2", status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "unit", durationMs: 5 },
        { lane: "observed-entry", id: "E-3", testCaseId: "TC-3", testCaseRevisionId: "REV-3", testCaseInstanceId: "INST-3", status: "PASSED", failureClassification: "NONE", executionSurface: "unit", durationMs: 5 },
      ],
    })));
    const observed = sarif.runs[0].results.filter((result: { ruleId: string }) => result.ruleId === "observed-failure");
    expect(observed).toHaveLength(2);
    expect(observed[0].locations[0].physicalLocation).toEqual({ artifactLocation: { uri: "specs/checkout.spec.ts" }, region: { startLine: 42 } });
    expect(observed[1].locations).toBeUndefined();
  });

  it("records the run id and, when an observed execution exists, its verified commit", () => {
    const sarif = JSON.parse(renderSarif(model({ anchor: { commitSha: "d".repeat(40), specTreeSha256: "e".repeat(64) } })));
    expect(sarif.runs[0].automationDetails.id).toBe("RUN-1");
    expect(sarif.runs[0].versionControlProvenance[0].revisionId).toBe("d".repeat(40));
    expect(JSON.parse(renderSarif(model())).runs[0].versionControlProvenance).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/reporting/projections/sarif.test.ts`
Expected: FAIL — cannot resolve `sarif.js`.

- [ ] **Step 4: Write the implementation**

Create `src/reporting/projections/sarif.ts`:

```ts
import { runtimeVersion } from "../../installer/manifest.js";
import type { AttemptRow, ProjectionModel } from "./projection-model.js";

type SarifResult = {
  ruleId: string;
  level: "error" | "warning";
  message: { text: string };
  locations?: readonly { physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } } }[];
};

function observedResult(row: AttemptRow): SarifResult {
  const message = { text: `observed execution reported ${row.testCaseId} ${row.testCaseInstanceId} as ${row.status} (${row.failureClassification}) on the ${row.executionSurface} surface` };
  // A location is attached only when one was JOINED from the sanitized report. Everything else in this
  // file has no file position that exists, and inventing one — from change-scope, from a test case, from
  // anywhere — would assert more than the run knows.
  return row.location === undefined
    ? { ruleId: "observed-failure", level: "error", message }
    : { ruleId: "observed-failure", level: "error", message, locations: [{ physicalLocation: { artifactLocation: { uri: row.location.file }, ...(row.location.line === undefined ? {} : { region: { startLine: row.location.line } }) } }] };
}

export function renderSarif(model: ProjectionModel): string {
  const results: SarifResult[] = [
    ...model.gate.verdicts.filter((verdict) => !verdict.passed)
      .map((verdict) => ({ ruleId: verdict.rule, level: "error" as const, message: { text: verdict.reason } })),
    ...model.findings.map((finding) => ({ ruleId: finding.ruleId, level: finding.level, message: { text: finding.message } })),
    ...model.attempts.filter((row) => row.lane === "observed-entry" && row.status === "FAILED").map(observedResult),
  ];
  const ruleIds = [...new Set(results.map((result) => result.ruleId))];
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "qa-skills", version: runtimeVersion, informationUri: "https://github.com/dangnhit/qa-tester", rules: ruleIds.map((id) => ({ id })) } },
      automationDetails: { id: model.runId },
      // SARIF has a field for exactly the anchor lane 2 already proves, so filling it asserts nothing
      // new. A run with no observed execution has no verified revision and omits the field entirely.
      ...(model.anchor === undefined ? {} : { versionControlProvenance: [{ repositoryUri: "", revisionId: model.anchor.commitSha }] }),
      results,
    }],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}
```

If schema validation rejects `repositoryUri: ""`, replace the `versionControlProvenance` entry with `{ revisionId: model.anchor.commitSha }` alone and record why in the commit — the schema is the authority here, not this plan.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/reporting/projections/sarif.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Prove each test by mutation**

| Test | Mutation | Expected red |
| --- | --- | --- |
| schema validity | emit `level: "critical"` | schema validation returns false |
| result set | drop the `.filter((verdict) => !verdict.passed)` | `VALID_ARTIFACTS` appears in the result list |
| location honesty | give a locationless row `{ uri: "unknown" }` | `observed[1].locations` is no longer undefined |
| anchor | emit `versionControlProvenance` unconditionally | the no-anchor assertion fails |

- [ ] **Step 7: Run the full gate** (same nine commands)

- [ ] **Step 8: Commit**

```bash
git add src/reporting/projections/sarif.ts fixtures/sarif/sarif-2.1.0-schema.json tests/reporting/projections/sarif.test.ts
git commit -m "feat: render a SARIF projection, validated against the official schema

A SARIF file that is invalid against the 2.1.0 schema fails outside our test
boundary -- at GitHub's upload -- which is the worst place to find out. The
schema is vendored and checked with the ajv already present, so no dependency
is added. It is compiled by a test-local plain Ajv because the shared catalog
instance is Ajv2020 with strict:true and the SARIF schema is draft-07.

A result carries a location only when one was joined from the sanitized report.
Inventing one -- from change-scope, whose git-diff provenance nothing verifies,
or from a test case -- would assert more than the run knows.

versionControlProvenance carries the observed execution's commitSha: SARIF has
a field for exactly the anchor lane 2 already proves.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Join an observed failure to its spec location

**Files:**
- Create: `src/reporting/projections/spec-locations.ts`
- Modify: `src/reporting/projections/projection-model.ts`
- Test: `tests/reporting/projections/spec-locations.test.ts`

**Interfaces:**
- Consumes: `ProjectionArtifact`, `AttemptRow` from Task 1.
- Produces: `specLocationsByEntryIdentity(artifacts: readonly ProjectionArtifact[]): ReadonlyMap<string, ProjectionLocation>`, keyed by `` `${testCaseId}/${revisionId}/${instanceId}@${surface}` ``.

- [ ] **Step 1: Read the shapes before writing anything**

Read `src/observed/sanitize-report.ts` (the payload the evidence artifact carries, and which of `suites`/`specs` nests which) and `src/observed/report-mapping.ts:38-50,118-140` (the identity tag pattern and its refusal rules). **Reuse the tag's grammar; do not re-invent a regex.** Record in the task report the exact JSON path from an `evidence` artifact value to a spec's `file` and `line`. If the sanitized payload nests suites recursively, the traversal must recurse — write that down before implementing.

- [ ] **Step 2: Write the failing test**

Create `tests/reporting/projections/spec-locations.test.ts`. Build the fixture from the shape recorded in Step 1 — an `evidence` artifact whose sanitized payload holds one suite with two specs, one tagged `[qa:TC-1/REV-1/INST-1@api]` at `specs/checkout.spec.ts:42` and one untagged — and assert:

```ts
describe("specLocationsByEntryIdentity", () => {
  it("finds a tagged spec's file and line", () => {
    expect(specLocationsByEntryIdentity([evidenceArtifact]).get("TC-1/REV-1/INST-1@api"))
      .toEqual({ file: "specs/checkout.spec.ts", line: 42 });
  });

  it("returns nothing for an untagged spec, rather than guessing which entry it belongs to", () => {
    expect(specLocationsByEntryIdentity([evidenceArtifact]).size).toBe(1);
  });

  it("returns an empty map when the run registered no sanitized report at all", () => {
    expect(specLocationsByEntryIdentity([]).size).toBe(0);
  });

  it("attaches the joined location to the matching attempt row and to no other", () => {
    const model = buildProjectionModel({ ...base, artifacts: [gateArtifact, batchWithTaggedEntry, evidenceArtifact] });
    expect(model.attempts.find((row) => row.id === "E-1")?.location).toEqual({ file: "specs/checkout.spec.ts", line: 42 });
    expect(model.attempts.find((row) => row.id === "E-2")?.location).toBeUndefined();
  });
});
```

`gateArtifact` and `base` are the Task 1 fixtures — redeclare them locally in this file rather than exporting them from the other test; `batchWithTaggedEntry` is Task 1's `batch` fixture with its first entry's identity set to `TC-1`/`REV-1`/`INST-1` on the `api` surface, matching the tag; `evidenceArtifact` is built from the payload shape recorded in Step 1.

`AttemptRow` already carries `testCaseRevisionId` from Task 1, so the join key is the full four-part identity. Do not fall back to a partial key: it would join two entries that differ only by revision.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/reporting/projections/spec-locations.test.ts`
Expected: FAIL — cannot resolve `spec-locations.js`.

- [ ] **Step 4: Implement the join**

Create `src/reporting/projections/spec-locations.ts`. Fill the two marked places from what Step 1 measured — the JSON path into the sanitized payload, and whether suites nest:

```ts
import { isRecord } from "../../core/values.js";
import type { ProjectionArtifact, ProjectionLocation } from "./projection-model.js";

/** The identity tag's grammar, kept identical to `report-mapping.ts:41` on purpose: the tag is written
 *  once, by the spec author, and read in two places. Two grammars that drift would make a spec that
 *  produces a batch entry produce no location, silently. */
const identityTagPattern = /\[qa:([^\][/@\s]+)\/([^\][/@\s]+)\/([^\][/@\s]+)@([^\][/@\s]+)\]/;

export const specLocationKey = (identity: Readonly<{ testCaseId: string; testCaseRevisionId: string; testCaseInstanceId: string; executionSurface: string }>): string =>
  `${identity.testCaseId}/${identity.testCaseRevisionId}/${identity.testCaseInstanceId}@${identity.executionSurface}`;

export function specLocationsByEntryIdentity(artifacts: readonly ProjectionArtifact[]): ReadonlyMap<string, ProjectionLocation> {
  const found = new Map<string, ProjectionLocation>();
  const ambiguous = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.record.type !== "evidence") continue;
    const payload = /* STEP 1: the measured path from the evidence value to the sanitized report */ undefined as unknown;
    for (const spec of collectSpecs(payload)) {
      const title = typeof spec.title === "string" ? spec.title : "";
      const file = typeof spec.file === "string" && spec.file.length > 0 ? spec.file : undefined;
      const match = identityTagPattern.exec(title);
      if (match === undefined || match === null || file === undefined) continue;
      const key = `${match[1]}/${match[2]}/${match[3]}@${match[4]}`;
      // A duplicate identity means two specs claim the same entry. An ambiguous location is a guess
      // wearing a file path, so the key is poisoned rather than resolved to whichever came first.
      if (found.has(key)) { ambiguous.add(key); continue; }
      found.set(key, typeof spec.line === "number" ? { file, line: spec.line } : { file });
    }
  }
  for (const key of ambiguous) found.delete(key);
  return found;
}

/** STEP 1 decides whether this recurses. If the sanitized payload nests suites inside suites, walk
 *  them; if it is flat, this is a single flatMap. Write down which it is before implementing. */
function collectSpecs(payload: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!isRecord(payload)) return [];
  /* STEP 1: traversal over suites -> specs */
  return [];
}
```

In `buildProjectionModel`, build the map once and attach the location to observed rows only:

```ts
  const locations = specLocationsByEntryIdentity(input.artifacts);
  // ...inside the observed-entry row construction, after the identity fields are known:
  const location = locations.get(specLocationKey({ testCaseId, testCaseRevisionId, testCaseInstanceId, executionSurface }));
  return [{ lane: "observed-entry" as const, /* ...as before... */, ...(location === undefined ? {} : { location }) }];
```

Lane-1 rows never get a location: a driven attempt has no spec file at all.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/reporting/projections/`
Expected: PASS, all files.

- [ ] **Step 6: Prove each test by mutation**

| Test | Mutation | Expected red |
| --- | --- | --- |
| tagged spec found | key the map on `testCaseId` alone | the four-part lookup misses |
| untagged spec ignored | map untagged specs under their title | map size becomes 2 |
| no report | return a map with a placeholder entry | size assertion fails |
| attachment | attach the location to every observed row | `E-2` gains a location it has no evidence for |

- [ ] **Step 7: Run the full gate** (same nine commands)

- [ ] **Step 8: Commit**

```bash
git add src/reporting/projections/spec-locations.ts src/reporting/projections/projection-model.ts tests/reporting/projections/spec-locations.test.ts
git commit -m "feat: join an observed failure to the spec file that produced it

A test-result-batch entry carries no path -- ObservedEntry has no file field,
only ExcludedSpec does. The path exists solely in the sanitized report, where
sanitize-report.ts keeps title/file/line/column because the line it draws is
committed spec-tree content versus run-time output.

The join is on the FULL four-part identity from the spec's own [qa:...] tag.
Keying on testCaseId alone would join two entries that differ only by revision,
and an ambiguous location is a guess wearing a file path.

An untagged spec, a malformed tag and a duplicate identity are all skipped
rather than resolved to a best guess.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Sidecar, export operation, and the CLI command

**Files:**
- Create: `src/reporting/projections/sidecar.ts`
- Create: `src/operations/export-projection.ts`
- Modify: `src/cli/program.ts` (add the command after the `validate` command block, which ends at line 275)
- Test: `tests/operations/export-projection.test.ts`, `tests/cli/export.test.ts`

**Interfaces:**
- Consumes: `buildProjectionModel`, `renderJUnit`, `renderSarif` from Tasks 1–4.
- Produces: `renderSidecar(model, bytes)`, `exportProjection(options): Promise<{ outPath: string; sidecarPath: string; projectionSha256: string }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/operations/export-projection.test.ts`, driving a real finalized run workspace the way the existing operations tests do (copy the setup idiom from `tests/operations/` — do not invent a new fixture style):

```ts
describe("exportProjection", () => {
  it("writes the projection and a sidecar whose checksum matches the bytes on disk", async () => {
    const result = await exportProjection({ root, runId, format: "junit", outPath: join(tmp, "qa-junit.xml") });
    const bytes = await readFile(result.outPath);
    const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf8"));
    expect(sidecar.projectionSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(sidecar).toMatchObject({ projection: "junit", runId, gate: { recommendation: expect.any(String) }, reduced: false });
    expect(sidecar.producerVersion).toBe(runtimeVersion);
  });

  it("refuses a run that was never finalized, naming the missing gate", async () => {
    await expect(exportProjection({ root, runId: unfinalizedRunId, format: "sarif", outPath: join(tmp, "x.sarif") }))
      .rejects.toThrow(/release gate/i);
  });

  it("writes nothing inside the run workspace", async () => {
    const before = await readdir(join(root, "qa-results", runId));
    await exportProjection({ root, runId, format: "sarif", outPath: join(tmp, "qa.sarif") });
    expect(await readdir(join(root, "qa-results", runId))).toEqual(before);
  });
});
```

Create `tests/cli/export.test.ts` following the existing CLI test idiom:

```ts
it("exits 0 with the projection written, even when the gate is NOT_READY", async () => {
  const result = await runCli(["export", "--root", root, "--run-id", runId, "--format", "junit", "--out", outPath]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ format: "junit", outPath, sidecarPath: `${outPath}.provenance.json` });
});

it("exits 3 for an unknown format, an unknown run, and a run with no gate", async () => {
  for (const argv of [
    ["export", "--root", root, "--run-id", runId, "--format", "tap", "--out", outPath],
    ["export", "--root", root, "--run-id", "RUN-DOES-NOT-EXIST", "--format", "junit", "--out", outPath],
    ["export", "--root", root, "--run-id", unfinalizedRunId, "--format", "junit", "--out", outPath],
  ]) expect((await runCli(argv)).exitCode).toBe(3);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/operations/export-projection.test.ts tests/cli/export.test.ts`
Expected: FAIL — module and command do not exist.

- [ ] **Step 3: Implement the sidecar**

Create `src/reporting/projections/sidecar.ts`:

```ts
import { createHash } from "node:crypto";

import type { ProjectionModel } from "./projection-model.js";

/** Binds a derived file to the exact gate it projects. The projection is NOT a registered artifact —
 *  a finalized run is closed — so this sidecar is the only thing that lets a reader prove which gate,
 *  and which source artifacts, a given XML or SARIF file came from. Without it the file would be a
 *  self-certifying channel: a hand-edited XML would be indistinguishable from a real one.
 *
 *  `reduced` is the ONLY field naming the protected-environment condition. The spec's sample sidecar
 *  listed `protectedEnvironment` beside it; that is one bit under two names, and two names for one bit
 *  is a drift surface — the pair can only ever disagree by being wrong. `reduced` is the one that says
 *  what the file actually is. */
export function renderSidecar(model: ProjectionModel, projection: "junit" | "sarif", bytes: Uint8Array): string {
  return `${JSON.stringify({
    projection,
    projectionSha256: createHash("sha256").update(bytes).digest("hex"),
    runId: model.runId,
    gate: { artifactId: model.gate.artifactId, sha256: model.gate.sha256, recommendation: model.gate.recommendation },
    sourceArtifacts: model.sourceArtifacts,
    reduced: model.reduced,
    producerVersion: model.producerVersion,
    generatedAt: model.generatedAt,
  }, null, 2)}\n`;
}
```

- [ ] **Step 4: Implement the operation**

Create `src/operations/export-projection.ts`:

```ts
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { QaSkillsError } from "../core/errors.js";
import { RunWorkspace } from "../core/run-workspace.js";
import { runtimeVersion } from "../installer/manifest.js";
import { renderJUnit } from "../reporting/projections/junit.js";
import { buildProjectionModel } from "../reporting/projections/projection-model.js";
import { renderSarif } from "../reporting/projections/sarif.js";
import { renderSidecar } from "../reporting/projections/sidecar.js";

export type ProjectionFormat = "junit" | "sarif";
export type ExportProjectionResult = Readonly<{ format: ProjectionFormat; outPath: string; sidecarPath: string; projectionSha256: string; recommendation: string; reduced: boolean }>;

const isFormat = (value: string): value is ProjectionFormat => value === "junit" || value === "sarif";

export async function exportProjection(options: Readonly<{ root: string; runId: string; format: string; outPath: string }>): Promise<ExportProjectionResult> {
  if (!isFormat(options.format)) throw new QaSkillsError(`Unsupported projection format ${options.format}: use junit or sarif`, "INVALID_ARTIFACT");
  const outPath = resolve(options.outPath);
  const sidecarPath = `${outPath}.provenance.json`;
  const workspace = await RunWorkspace.open(options.root, options.runId);
  try {
    // `readRegisteredArtifacts` already throws ARTIFACT_BINDING when the workspace's bindings are
    // invalid (run-workspace.ts:448-450). That IS the verification. Deriving the gate a second time
    // here to compare against the persisted one is exactly the asymmetry the VALID_ARTIFACTS incident
    // records: two derivation paths that can disagree leave a persisted gate permanently mismatched.
    const artifacts = await workspace.readRegisteredArtifacts();
    const model = buildProjectionModel({ runId: workspace.runId, producerVersion: runtimeVersion, generatedAt: new Date().toISOString(), artifacts });
    const rendered = Buffer.from(options.format === "junit" ? renderJUnit(model) : renderSarif(model), "utf8");
    // The projection is written first and the sidecar second, so a sidecar never describes bytes that
    // do not exist. The reverse order would leave a provenance claim about a missing file.
    await writeFile(outPath, rendered);
    await writeFile(sidecarPath, renderSidecar(model, options.format, rendered), "utf8");
    return { format: options.format, outPath, sidecarPath, projectionSha256: createHash("sha256").update(rendered).digest("hex"), recommendation: model.gate.recommendation, reduced: model.reduced };
  } finally {
    await workspace.close();
  }
}
```

- [ ] **Step 5: Add the CLI command**

In `src/cli/program.ts`, after the `validate` command block:

```ts
  program.command("export")
    .description("Project a finalized run's release gate into a CI-readable file, with a provenance sidecar")
    .requiredOption("--root <path>", "Project root directory")
    .requiredOption("--run-id <id>", "Run workspace ID")
    .requiredOption("--format <format>", "junit or sarif")
    .requiredOption("--out <path>", "Path to write the projection; the sidecar is written to <out>.provenance.json")
    .action(async (commandOptions: { root: string; runId: string; format: string; out: string }) => {
      // Exit stays SUCCESS even when the gate is NOT_READY: exporting succeeded. `workflow run` already
      // carries the gate's verdict in its exit code (exit-codes.ts:39), and one code with two meanings
      // is worse than two commands.
      const result = await exportProjection({ root: commandOptions.root, runId: commandOptions.runId, format: commandOptions.format, outPath: commandOptions.out });
      stdout += `${JSON.stringify(result)}\n`;
    });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/operations/export-projection.test.ts tests/cli/export.test.ts`
Expected: PASS.

- [ ] **Step 7: Prove each test by mutation**

| Test | Mutation | Expected red |
| --- | --- | --- |
| sidecar checksum | hash the model instead of the bytes | checksum mismatch against the file on disk |
| refusal | catch and swallow the missing-gate error | the rejection assertion fails |
| workspace untouched | write the sidecar next to the gate inside `qa-results/<runId>/` | the directory listing changes |
| exit 0 on NOT_READY | set `exitCode = workflowExitCode(...)`-style mapping in the action | exit becomes 1 |
| exit 3 refusals | accept any `--format` string | the unknown-format case exits 0 |

- [ ] **Step 8: Run the full gate** (same nine commands)

- [ ] **Step 9: Commit**

```bash
git add src/reporting/projections/sidecar.ts src/operations/export-projection.ts src/cli/program.ts tests/operations/export-projection.test.ts tests/cli/export.test.ts
git commit -m "feat: add qa-skill export, writing a projection and its provenance sidecar

The projection is a derived file, never a registered artifact, and nothing is
written inside qa-results/<runId>/ -- a finalized run is closed. The sidecar is
what stops the file being a self-certifying channel: it binds the bytes, by
checksum, to the gate artifact and source artifacts they project.

Export exits 0 even when the gate is NOT_READY, because exporting succeeded.
workflow run already carries the gate's verdict at exit-codes.ts:39, and one
exit code with two meanings is worse than two commands. Refusals reuse
INVALID_INPUT; no new exit code is added.

readRegisteredArtifacts already throws ARTIFACT_BINDING on an invalid binding,
so that is the verification -- no second gate derivation was added.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Documentation — the GitHub Actions example and the recovery reference

**Files:**
- Modify: `README.md`
- Modify: `skills/shared/references/recovery.md`
- Test: `npm run check:examples` (the repo already checks documented examples)

**Interfaces:**
- Consumes: the `export` command surface from Task 6, verbatim.

- [ ] **Step 1: Verify the example against the real CLI before writing it**

Run the whole flow by hand against a demo run and paste the actual commands and outputs into the task report:

```bash
npx qa-skill workflow run --input <input>.json | tee qa-run.json; echo "exit=$?"
jq -r .runId qa-run.json
npx qa-skill export --root . --run-id "$(jq -r .runId qa-run.json)" --format junit --out qa-junit.xml
npx qa-skill export --root . --run-id "$(jq -r .runId qa-run.json)" --format sarif --out qa.sarif
```

An example that was never run is a guess. If `jq` is not the right extraction (for instance if `workflow run` prints more than one line), record what is and write that instead.

- [ ] **Step 2: Write the README section**

Add a "Consuming the gate in CI" section containing the workflow below, and, in prose, the one sentence a reader must not miss: **`workflow run` exits 1 on `NOT_READY`, so every export and upload step needs `if: always()` — without it the pipeline loses its projections in exactly the case they exist for.**

```yaml
- id: qa
  continue-on-error: true
  run: npx qa-skill workflow run --input workflow-input.json | tee qa-run.json
- if: always()
  run: |
    RUN_ID=$(jq -r .runId qa-run.json)
    npx qa-skill export --root . --run-id "$RUN_ID" --format junit --out qa-junit.xml
    npx qa-skill export --root . --run-id "$RUN_ID" --format sarif --out qa.sarif
- if: always()
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: qa.sarif
- if: steps.qa.outcome == 'failure'
  run: exit 1
```

Document alongside it: the sidecar and what it proves; that a protected-environment run produces a reduced projection carrying identifiers and counts but no authored text; and that a SARIF result without a location is a result the run has no honest file position for.

- [ ] **Step 3: Extend the recovery reference**

In `skills/shared/references/recovery.md`, add `qa-skill export` with its two outcomes — 0 on success including `NOT_READY`, 3 on refusal — and the three refusal causes (no such run, no release gate, unknown format), so an agent reading only the bundle can produce CI artifacts.

- [ ] **Step 4: Run the checks**

Run: `npm run check:examples && npm run lint`
Expected: PASS.

- [ ] **Step 5: Run the full gate** (same nine commands)

- [ ] **Step 6: Commit**

```bash
git add README.md skills/shared/references/recovery.md
git commit -m "docs: show a CI pipeline consuming the gate, and say what breaks it

workflow run exits 1 on NOT_READY, so every export and upload step carries
if: always(). Without it a pipeline loses its projections in exactly the case
they exist for, and loses them silently.

The example was run end to end before it was written down; the run id comes
from WorkflowResult.runId, which workflow run already prints.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Whole-branch close-out

After Task 7, before merging:

- [ ] Run `superpowers:requesting-code-review` for a whole-branch review with **opus**. Phase 7's whole-branch review found what four clean per-task reviews could not, because the defect lived above every slice. Budget for that here: the question this branch's reviewer should be pointed at is **whether anything authored outside the artifact system reaches a projection**, and whether the reduced mode's allowlist is enforced everywhere rather than at one site.
- [ ] Verify the gate yourself at branch HEAD — all nine commands from a deleted `dist/` — rather than trusting an implementer's numbers. Two prior sessions caught a controller claiming verification it had not done.
- [ ] Record the outcome in `.superpowers/sdd/progress.md` under a `PHASE 8a` heading, including every finding, every deferral, and the reasoning.
- [ ] Close with `superpowers:finishing-a-development-branch`.

## Open questions carried into implementation

Two of the spec's five verification items are now settled by measurement and are recorded above: lane 1's surface (`release-gate.ts:63-70`) and which verdict reason can carry authored text (`NO_SHARED_BLOCKERS`, via `affectedClaim`). Three remain, each assigned:

1. **What `RunWorkspace.open` + `readRegisteredArtifacts` verify** — Task 6, Step 4. The reader throws `ARTIFACT_BINDING` on an invalid binding; confirm that covers the gate's own binding, and if it does not, **report rather than adding a second derivation**.
2. **GitHub's handling of a SARIF result with no `locations`** — Task 7, Step 2. Measure against a real upload. If such results are not displayed, that is a documentation obligation, not a licence to fabricate locations.
3. **The vendored schema's size and licence** — Task 4, Step 1, with an explicit stop-and-report threshold at 2 MB.
