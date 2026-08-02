import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Text } from "../../src/core/checksum.js";
import { QaSkillsError } from "../../src/core/errors.js";
import type { WorkspaceDiagnostic } from "../../src/core/run-workspace.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";

/**
 * Phase 1 CHARACTERIZATION spec — pins the CURRENT behavior of the two hand-written
 * semantic-rule chains in `src/core/run-workspace.ts` for the three overlapping planning
 * artifact types before Phase 2 unifies them into a single rule table:
 *
 *  - WRITE path: `assertSemanticReferences` (registration time), reached through
 *    `registerArtifactValue`. Hard-throws `QaSkillsError` on a binding violation.
 *  - READ path: `assertPersistedPlanningSemantics` (workspace open/validate time), reached
 *    through `RunWorkspace.validate`. Emits a soft `INVALID_REFERENCE` diagnostic and marks
 *    the artifact invalid; it never throws out of `validate`.
 *
 * These assertions LOCK current behavior — including where the two paths disagree. They do
 * NOT fix anything. The companion drift ledger is `docs/reports/semantic-rule-drift.md`.
 *
 * Reaching the READ path for an invalid input that the WRITE path would reject requires
 * persisting a bad artifact. We use the established tamper-and-rechecksum technique
 * (rewrite the file bytes, then recompute the manifest sha256) to reach those branches.
 */

const roots: string[] = [];
const openWorkspaces: RunWorkspace[] = [];

afterEach(async () => {
  await Promise.all(openWorkspaces.splice(0).map((workspace) => workspace.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const environmentProfile = {
  artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0",
  environmentProfileId: "env-test", name: "Test", classification: "test",
  baseUrl: "https://test.example.test", productionReadOnly: false,
} as const;

async function freshWorkspace(): Promise<RunWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "qa-skills-semantic-rules-"));
  roots.push(root);
  const workspace = await RunWorkspace.create({ root, mode: "plan", environmentProfile });
  openWorkspaces.push(workspace);
  return workspace;
}

/** A schema-valid requirement analysis. `AUTHORITATIVE` is the provenance-derived authority
 * for this "must" statement, so the default value is accepted by both paths. */
function requirementAnalysis(overrides: { authority?: string; statementCount?: number } = {}): Record<string, unknown> {
  const statement = {
    requirementId: "REQ", sourceProvenance: { kind: "user", reference: "fixture" },
    normalizedText: "Members must save profile.", authority: overrides.authority ?? "AUTHORITATIVE",
    role: "member", rules: [], risks: [], assumptions: [], openQuestions: [],
  };
  return {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA",
    statements: Array.from({ length: overrides.statementCount ?? 1 }, () => JSON.parse(JSON.stringify(statement)) as Record<string, unknown>),
  };
}

function coverageObligation(requirementAnalysisArtifactId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactType: "coverage-obligation", schemaVersion: "4.0.0", producerVersion: "1.0.0", obligationId: "COV",
    requirementAnalysisArtifactId, requirementId: "REQ", role: "member", behavior: "save", executionSurface: "browser", browser: "chromium",
    viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "low", outcome: "Saved", required: true, ...overrides,
  };
}

function testPlan(overrides: Record<string, unknown> = {}, testCaseOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactType: "test-plan", schemaVersion: "1.0.0", producerVersion: "1.0.0", testPlanId: "PLAN",
    approvalPolicy: { mode: "human-review" },
    testCases: [{
      testCaseId: "TC", title: "Save",
      expectedResults: [{ id: "ER", requirementId: "REQ", authority: "AUTHORITATIVE", text: "Saved" }],
      steps: [{ id: "open", action: { kind: "navigate", url: "/" }, sideEffect: "none" }], openQuestions: [], ...testCaseOverrides,
    }],
    ...overrides,
  };
}

interface ManifestRecord { id: string; type: string; relativePath: string; sha256: string }
interface ManifestFile { artifacts: ManifestRecord[] }

/** Rewrites one registered artifact's bytes and recomputes its manifest checksum so the
 * tampered payload survives `inspectWorkspaceState`'s integrity gate and reaches the READ
 * semantic rules — the same technique used by the existing run-workspace/coverage tests. */
async function tamperRegistered(workspacePath: string, type: string, mutate: (value: Record<string, unknown>) => void): Promise<void> {
  const manifestPath = join(workspacePath, "artifact-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManifestFile;
  const record = manifest.artifacts.find((artifact) => artifact.type === type);
  if (!record) throw new Error(`Missing registered ${type}`);
  const filePath = join(workspacePath, record.relativePath);
  const value = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  mutate(value);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, contents);
  record.sha256 = sha256Text(contents);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Corrupts a registered artifact's bytes WITHOUT recomputing the checksum, so
 * `inspectWorkspaceState` invalidates it on checksum mismatch. Used to make the single
 * authoritative environment profile drop out of the valid set for the READ test-plan rule. */
async function corruptWithoutRechecksum(workspacePath: string, type: string, mutate: (value: Record<string, unknown>) => void): Promise<void> {
  const manifestPath = join(workspacePath, "artifact-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManifestFile;
  const record = manifest.artifacts.find((artifact) => artifact.type === type);
  if (!record) throw new Error(`Missing registered ${type}`);
  const filePath = join(workspacePath, record.relativePath);
  const value = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  mutate(value);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Diagnostics that the READ path attributes to one specific persisted artifact. Profile
 * completeness diagnostics carry no relativePath, so this isolates binding outcomes. */
async function targetDiagnostics(workspace: RunWorkspace, relativePath: string): Promise<WorkspaceDiagnostic[]> {
  const { diagnostics } = await workspace.validate();
  return diagnostics.filter((diagnostic) => diagnostic.relativePath === relativePath);
}

async function expectQaReject(promise: Promise<unknown>, code: string, message: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(QaSkillsError);
  const error = caught as QaSkillsError;
  expect(error.code).toBe(code);
  expect(error.message).toBe(message);
}

// Nested-field tamper helpers kept strictly typed (no `any`): every element access narrows
// from `unknown` through an explicit cast to `Record<string, unknown>`.
function firstStatement(value: Record<string, unknown>): Record<string, unknown> {
  const statements = value.statements;
  if (!Array.isArray(statements) || statements.length === 0) throw new Error("expected statements");
  return statements[0] as Record<string, unknown>;
}
function firstTestCase(value: Record<string, unknown>): Record<string, unknown> {
  const testCases = value.testCases;
  if (!Array.isArray(testCases) || testCases.length === 0) throw new Error("expected testCases");
  return testCases[0] as Record<string, unknown>;
}
function firstExpectedResult(value: Record<string, unknown>): Record<string, unknown> {
  const expectedResults = firstTestCase(value).expectedResults;
  if (!Array.isArray(expectedResults) || expectedResults.length === 0) throw new Error("expected expectedResults");
  return expectedResults[0] as Record<string, unknown>;
}

describe("semantic-rule characterization: requirement-analysis", () => {
  it("WRITE accepts an analysis whose authority matches its provenance-derived value", async () => {
    const workspace = await freshWorkspace();
    await expect(workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] }))
      .resolves.toMatchObject({ type: "requirement-analysis" });
  });

  it("WRITE rejects an analysis whose stated authority disagrees with its provenance", async () => {
    const workspace = await freshWorkspace();
    await expectQaReject(
      workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis({ authority: "ASSUMED" }), relationships: [] }),
      "ARTIFACT_BINDING",
      "Requirement authority ASSUMED disagrees with provenance-derived AUTHORITATIVE",
    );
  });

  it("READ accepts a persisted analysis whose authority matches its provenance", async () => {
    const workspace = await freshWorkspace();
    const analysis = await workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] });
    expect(await targetDiagnostics(workspace, analysis.relativePath)).toHaveLength(0);
  });

  it("READ rejects a persisted analysis whose authority was tampered to disagree with its provenance", async () => {
    const workspace = await freshWorkspace();
    const analysis = await workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] });
    await tamperRegistered(workspace.path, "requirement-analysis", (value) => { firstStatement(value).authority = "ASSUMED"; });
    expect(await targetDiagnostics(workspace, analysis.relativePath)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_REFERENCE", message: "Requirement authority ASSUMED disagrees with provenance-derived AUTHORITATIVE" }),
    ]));
  });
});

describe("semantic-rule characterization: coverage-obligation", () => {
  it("WRITE accepts an obligation bound to exactly one matching requirement statement", async () => {
    const workspace = await freshWorkspace();
    const analysis = await workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] });
    await expect(workspace.registerArtifactValue({ type: "coverage-obligation", value: coverageObligation(analysis.id), relationships: [] }))
      .resolves.toMatchObject({ type: "coverage-obligation" });
  });

  // WRITE-path branches. NOTE the first row: only the WRITE path has a dedicated
  // "orphan requirement analysis artifact" message; the READ path folds that same input
  // into its combined "orphan or ambiguous requirement" message (see the READ table).
  it.each([
    {
      label: "requirementAnalysisArtifactId references no registered analysis artifact",
      obligation: () => coverageObligation("does-not-exist-artifact-id"),
      analysisStatements: 1,
      message: "Coverage obligation references an orphan requirement analysis artifact",
    },
    {
      label: "requirementId is absent from the referenced analysis (orphan)",
      obligation: (analysisId: string) => coverageObligation(analysisId, { requirementId: "REQ-MISSING" }),
      analysisStatements: 1,
      message: "Coverage obligation references an orphan or ambiguous requirement",
    },
    {
      label: "requirementId is matched by two statements in the analysis (ambiguous)",
      obligation: (analysisId: string) => coverageObligation(analysisId),
      analysisStatements: 2,
      message: "Coverage obligation references an orphan or ambiguous requirement",
    },
  ])("WRITE rejects when $label", async ({ obligation, analysisStatements, message }) => {
    const workspace = await freshWorkspace();
    const analysis = await workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis({ statementCount: analysisStatements }), relationships: [] });
    await expectQaReject(
      workspace.registerArtifactValue({ type: "coverage-obligation", value: obligation(analysis.id), relationships: [] }),
      "ARTIFACT_BINDING",
      message,
    );
  });

  it("READ accepts a persisted obligation bound to exactly one matching requirement statement", async () => {
    const workspace = await freshWorkspace();
    const analysis = await workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] });
    const obligation = await workspace.registerArtifactValue({ type: "coverage-obligation", value: coverageObligation(analysis.id), relationships: [] });
    expect(await targetDiagnostics(workspace, obligation.relativePath)).toHaveLength(0);
  });

  // READ-path branches. After Phase 2a (drift reconciliation #1, product-owner approved), the
  // orphan-ANALYSIS-ARTIFACT input adopts the WRITE path's specific message on BOTH paths; the
  // orphan-REQUIREMENT and ambiguous-STATEMENT inputs keep the combined message. See
  // docs/reports/semantic-rule-drift.md "What Phase 2 must decide" item 1.
  it.each([
    {
      label: "requirementAnalysisArtifactId is tampered to reference no analysis artifact",
      tamper: (workspacePath: string) => tamperRegistered(workspacePath, "coverage-obligation", (value) => { value.requirementAnalysisArtifactId = "does-not-exist-artifact-id"; }),
      analysisStatements: 1,
      message: "Coverage obligation references an orphan requirement analysis artifact",   // drift 1: was the combined message
    },
    {
      label: "requirementId is tampered to one absent from the analysis (orphan)",
      tamper: (workspacePath: string) => tamperRegistered(workspacePath, "coverage-obligation", (value) => { value.requirementId = "REQ-MISSING"; }),
      analysisStatements: 1,
      message: "Coverage obligation references an orphan or ambiguous requirement",
    },
    {
      label: "the analysis is tampered to duplicate the matching statement (ambiguous)",
      tamper: (workspacePath: string) => tamperRegistered(workspacePath, "requirement-analysis", (value) => {
        const statements = value.statements;
        if (!Array.isArray(statements) || statements.length === 0) throw new Error("expected statements");
        statements.push(JSON.parse(JSON.stringify(statements[0])) as Record<string, unknown>);
      }),
      analysisStatements: 1,
      message: "Coverage obligation references an orphan or ambiguous requirement",
    },
  ])("READ rejects when $label", async ({ tamper, analysisStatements, message }) => {
    const workspace = await freshWorkspace();
    const analysis = await workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis({ statementCount: analysisStatements }), relationships: [] });
    const obligation = await workspace.registerArtifactValue({ type: "coverage-obligation", value: coverageObligation(analysis.id), relationships: [] });
    await tamper(workspace.path);
    expect(await targetDiagnostics(workspace, obligation.relativePath)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_REFERENCE", message }),
    ]));
  });

  // §8 risk 1 CASCADE LOCK: drift 1 must NOT leak into the cascade case. When the referenced analysis
  // is INVALIDATED (checksum mismatch) but its record REMAINS registered in the manifest, message 2
  // keys on manifest existence (record still present → skipped) and message 3 keys on the
  // cascade-sensitive valid pool (analysis dropped out → fires), so the COMBINED message still
  // surfaces. This confines drift 1 to the genuinely-missing-record case.
  it("READ keeps the combined message when the referenced analysis is invalidated but still registered (cascade)", async () => {
    const workspace = await freshWorkspace();
    const analysis = await workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] });
    const obligation = await workspace.registerArtifactValue({ type: "coverage-obligation", value: coverageObligation(analysis.id), relationships: [] });
    // Corrupt the analysis bytes WITHOUT recomputing its checksum: inspectWorkspaceState invalidates
    // it on CHECKSUM_MISMATCH, so it drops out of the valid pool while its manifest record survives.
    await corruptWithoutRechecksum(workspace.path, "requirement-analysis", (value) => { value.requirementAnalysisId = "TAMPERED"; });
    expect(await targetDiagnostics(workspace, obligation.relativePath)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_REFERENCE", message: "Coverage obligation references an orphan or ambiguous requirement" }),
    ]));
  });
});

describe("semantic-rule characterization: test-plan", () => {
  it("WRITE accepts a plan and derives the human-review approval decision", async () => {
    const workspace = await freshWorkspace();
    const analysis = await workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] });
    const plan = await workspace.registerArtifactValue({ type: "test-plan", value: testPlan(), relationships: [analysis.id] });
    const persisted = JSON.parse(await readFile(plan.absolutePath, "utf8")) as Record<string, unknown>;
    expect(persisted.approvalDecision).toEqual({ approved: false, mode: "HUMAN_REVIEW", reasons: ["policy-requires-human-review"] });
  });

  it.each([
    {
      label: "the caller self-asserts an approvalDecision (workspace must derive it)",
      value: () => testPlan({ approvalDecision: { approved: false, mode: "HUMAN_REVIEW", reasons: ["policy-requires-human-review"] } }),
      code: "ARTIFACT_BINDING",
      message: "Test plan approval decision is derived by workspace registration and cannot be self-asserted",
    },
    {
      label: "an auto-approve-safe policy derives an unsafe (non-approved) decision",
      value: () => testPlan({ approvalPolicy: { mode: "auto-approve-safe" } }, { openQuestions: ["why"] }),
      code: "UNSAFE_OPERATION",
      message: "Unsafe auto-approval: open-questions",
    },
    {
      label: "an expected result references a requirement absent from every analysis",
      value: () => testPlan({}, { expectedResults: [{ id: "ER", requirementId: "REQ-ORPHAN", authority: "AUTHORITATIVE", text: "Saved" }] }),
      code: "ARTIFACT_BINDING",
      message: "Test plan has an orphan or ambiguous expected result requirement",
    },
    {
      // The schema lets expectedResults[].authority be any enum value with no tie to the
      // referenced requirement's own authority, so this mismatch is independently triggerable.
      label: "an expected result's authority disagrees with its registered requirement's authority",
      value: () => testPlan({}, { expectedResults: [{ id: "ER", requirementId: "REQ", authority: "ASSUMED", text: "Saved" }] }),
      code: "ARTIFACT_BINDING",
      message: "Test plan expected authority does not match its registered requirement",
    },
  ])("WRITE rejects when $label", async ({ value, code, message }) => {
    const workspace = await freshWorkspace();
    const analysis = await workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] });
    await expectQaReject(
      workspace.registerArtifactValue({ type: "test-plan", value: value(), relationships: [analysis.id] }),
      code,
      message,
    );
  });

  it("READ accepts a persisted plan whose approvalDecision equals the derived decision", async () => {
    const workspace = await freshWorkspace();
    const analysis = await workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] });
    const plan = await workspace.registerArtifactValue({ type: "test-plan", value: testPlan(), relationships: [analysis.id] });
    expect(await targetDiagnostics(workspace, plan.relativePath)).toHaveLength(0);
  });

  it.each([
    {
      label: "the persisted approvalDecision no longer equals the derived decision",
      tamper: (workspacePath: string) => tamperRegistered(workspacePath, "test-plan", (value) => { value.approvalDecision = { approved: false, mode: "HUMAN_REVIEW", reasons: ["tampered-reason"] }; }),
      message: "Persisted test plan approval decision does not equal the derived decision",
    },
    {
      label: "an expected result is tampered to reference an orphan requirement",
      tamper: (workspacePath: string) => tamperRegistered(workspacePath, "test-plan", (value) => { firstExpectedResult(value).requirementId = "REQ-ORPHAN"; }),
      message: "Test plan has an orphan or ambiguous expected result requirement",
    },
    {
      label: "an expected result's authority is tampered to disagree with its registered requirement",
      tamper: (workspacePath: string) => tamperRegistered(workspacePath, "test-plan", (value) => { firstExpectedResult(value).authority = "ASSUMED"; }),
      message: "Test plan expected authority does not match its registered requirement",
    },
    {
      label: "the single authoritative environment profile drops out of the valid set",
      tamper: (workspacePath: string) => corruptWithoutRechecksum(workspacePath, "environment-profile", (value) => { value.name = "Tampered"; }),
      message: "Test plan requires one authoritative environment profile",
    },
  ])("READ rejects when $label", async ({ tamper, message }) => {
    const workspace = await freshWorkspace();
    const analysis = await workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] });
    const plan = await workspace.registerArtifactValue({ type: "test-plan", value: testPlan(), relationships: [analysis.id] });
    await tamper(workspace.path);
    expect(await targetDiagnostics(workspace, plan.relativePath)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_REFERENCE", message }),
    ]));
  });

  // DRIFT: accept-vs-reject disagreements between the two paths on the SAME plan shape.
  // Both are reached by tampering a valid plan into a state the WRITE path forbids and the
  // READ path tolerates, proving the READ path lacks two rules the WRITE path enforces.
  it("DRIFT: READ accepts an unsafe auto-approve-safe plan that WRITE rejects (no read-side unsafe-approval guard)", async () => {
    const workspace = await freshWorkspace();
    const analysis = await workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] });
    const plan = await workspace.registerArtifactValue({ type: "test-plan", value: testPlan(), relationships: [analysis.id] });
    // Persist an auto-approve-safe plan whose derived decision is NON-approved, with a
    // persisted approvalDecision that matches that derivation. WRITE would throw
    // UNSAFE_OPERATION on this exact value (asserted below); READ accepts it.
    await tamperRegistered(workspace.path, "test-plan", (value) => {
      value.approvalPolicy = { mode: "auto-approve-safe" };
      firstTestCase(value).openQuestions = ["why"];
      value.approvalDecision = { approved: false, mode: "HUMAN_REVIEW", reasons: ["open-questions"] };
    });
    expect(await targetDiagnostics(workspace, plan.relativePath)).toHaveLength(0);

    // Same value on the WRITE path is rejected.
    const writeWorkspace = await freshWorkspace();
    const writeAnalysis = await writeWorkspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] });
    await expectQaReject(
      writeWorkspace.registerArtifactValue({ type: "test-plan", value: testPlan({ approvalPolicy: { mode: "auto-approve-safe" } }, { openQuestions: ["why"] }), relationships: [writeAnalysis.id] }),
      "UNSAFE_OPERATION",
      "Unsafe auto-approval: open-questions",
    );
  });

  it("DRIFT: READ requires the approvalDecision field that WRITE forbids on input", async () => {
    // READ: a persisted plan carries a (correct) approvalDecision and is accepted — the READ
    // path actually REQUIRES the field to be present and equal to the derived decision.
    const readWorkspace = await freshWorkspace();
    const readAnalysis = await readWorkspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] });
    const plan = await readWorkspace.registerArtifactValue({ type: "test-plan", value: testPlan(), relationships: [readAnalysis.id] });
    const persisted = JSON.parse(await readFile(plan.absolutePath, "utf8")) as Record<string, unknown>;
    expect(persisted.approvalDecision).toBeDefined();
    expect(await targetDiagnostics(readWorkspace, plan.relativePath)).toHaveLength(0);

    // WRITE: the same field on the input is rejected outright, even when its value is correct.
    const writeWorkspace = await freshWorkspace();
    const writeAnalysis = await writeWorkspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] });
    await expectQaReject(
      writeWorkspace.registerArtifactValue({ type: "test-plan", value: testPlan({ approvalDecision: { approved: false, mode: "HUMAN_REVIEW", reasons: ["policy-requires-human-review"] } }), relationships: [writeAnalysis.id] }),
      "ARTIFACT_BINDING",
      "Test plan approval decision is derived by workspace registration and cannot be self-asserted",
    );
  });
});

describe("semantic-rule characterization: schema-guarded (unreachable) binding branches", () => {
  // Both chains contain a leading "is the binding present and a string?" guard that the
  // JSON schema already enforces, so registration/inspection rejects the payload before the
  // semantic rule runs. These tests pin that the guarded branch is UNREACHABLE via the public
  // API on both paths — the drift ledger records them as "unreachable via public API".
  it("WRITE cannot reach the coverage-obligation binding-type branch (schema rejects first)", async () => {
    const workspace = await freshWorkspace();
    const analysis = await workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] });
    await expectQaReject(
      // requirementId must be a non-empty string per schema; a number fails contract validation
      // (INVALID_ARTIFACT) long before `assertCoverageObligationBinding`'s ARTIFACT_BINDING branch.
      workspace.registerArtifactValue({ type: "coverage-obligation", value: coverageObligation(analysis.id, { requirementId: 42 }), relationships: [] }),
      "INVALID_ARTIFACT",
      "Artifact does not match its contract: /requirementId must be string (type)",
    );
  });

  it("READ cannot reach the coverage-obligation binding-type branch (payload fails contract, value never bound)", async () => {
    const workspace = await freshWorkspace();
    const analysis = await workspace.registerArtifactValue({ type: "requirement-analysis", value: requirementAnalysis(), relationships: [] });
    const obligation = await workspace.registerArtifactValue({ type: "coverage-obligation", value: coverageObligation(analysis.id), relationships: [] });
    // Tamper requirementId to a non-string: `inspectWorkspaceState` fails contract validation
    // and flags ARTIFACT_TYPE_MISMATCH, so the payload is never bound and the READ semantic
    // rule's "requirement binding is invalid" throw is never reached.
    await tamperRegistered(workspace.path, "coverage-obligation", (value) => { value.requirementId = 42; });
    const diagnostics = await targetDiagnostics(workspace, obligation.relativePath);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ARTIFACT_TYPE_MISMATCH" }),
    ]));
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "Coverage obligation requirement binding is invalid" }),
    ]));
  });
});
