import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Text } from "../../src/core/checksum.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { evaluateWorkspaceCoverage } from "../../src/operations/evaluate-workspace-coverage.js";
import { deriveReleaseGateFromWorkspaceArtifacts } from "../../src/reporting/release-gate.js";

const roots: string[] = [];
const environmentProfile = {
  artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0",
  environmentProfileId: "env-test", name: "Test", classification: "test",
  baseUrl: "https://test.example.test", productionReadOnly: false,
} as const;

/** The dimensions an obligation carries on every Execution Surface. */
const surfacelessDimensions = {
  requirementId: "REQ-SAVE", role: "member", behavior: "save profile",
  accessibilityMethod: "keyboard", risk: "high", outcome: "confirmation shown",
} as const;
/** Plus the two only the browser surface owns; `test-case.coverage` always carries both. */
const dimensions = { ...surfacelessDimensions, browser: "chromium", viewport: { width: 1440, height: 900 } } as const;

async function setup(overrides: {
  requirementAuthority?: string; result?: Record<string, unknown>; resultProvenance?: string;
  testCase?: Record<string, unknown>; obligation?: Record<string, unknown>; obligationSurface?: string;
  omitResult?: boolean; batchEntries?: readonly Record<string, unknown>[]; batchProvenance?: string;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "qa-skills-workspace-coverage-"));
  roots.push(root);
  const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile });
  const register = async (type: Parameters<RunWorkspace["registerArtifactValue"]>[0]["type"], value: Record<string, unknown>) =>
    workspace.registerArtifactValue({ type, value, relationships: [] });
  const requirement = await register("requirement-analysis", {
    artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-SAVE",
    statements: [{ requirementId: dimensions.requirementId, sourceProvenance: { kind: overrides.requirementAuthority === "INFERRED" ? "code" : "user", reference: "ticket-1" }, normalizedText: "Members must be able to save their profile.", authority: overrides.requirementAuthority ?? "AUTHORITATIVE", role: dimensions.role, rules: [], risks: [], assumptions: [], openQuestions: [] }],
  });
  // `browser` + `viewport` belong to the browser surface only; the schema forbids them elsewhere.
  const surface = overrides.obligationSurface ?? "browser";
  await register("coverage-obligation", {
    artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0", obligationId: "COV-SAVE", requirementAnalysisArtifactId: requirement.id,
    executionSurface: surface, ...(surface === "browser" ? dimensions : surfacelessDimensions), required: true, ...overrides.obligation,
  });
  const { coverage: coverageOverride, ...testCaseOverrides } = overrides.testCase ?? {};
  const testCase = await register("test-case", {
    artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "1.0.0", testCaseId: "TC-SAVE", revisionId: "REV-SAVE", instanceId: "TC-SAVE--INSTANCE-1", title: "Saves a profile",
    steps: [{ id: "save", action: "click", sideEffect: "none" }], coverage: { ...dimensions, ...(coverageOverride ?? {}) }, ...testCaseOverrides,
  });
  if (overrides.omitResult !== true) {
    await workspace.registerArtifactValue({ type: "test-result", relationships: [testCase.id], provenance: overrides.resultProvenance ?? "runtime-execution", value: {
      artifactType: "test-result", schemaVersion: "2.0.0", producerVersion: "1.0.0", attemptId: "ATTEMPT-SAVE", runId: workspace.runId, testCaseId: "TC-SAVE", testCaseRevisionId: "REV-SAVE", testCaseInstanceId: "TC-SAVE--INSTANCE-1", status: "PASSED", failureClassification: "NONE", observedEngine: "chromium", steps: [{ stepId: "save", status: "PASSED", durationMs: 1 }], startedAt: "2026-07-23T12:34:56.000Z", finishedAt: "2026-07-23T12:35:56.000Z", ...overrides.result,
    } });
  }
  if (overrides.batchEntries !== undefined) {
    await workspace.registerArtifactValue({ type: "test-result-batch", relationships: [testCase.id], provenance: overrides.batchProvenance ?? "runtime-observed", value: {
      artifactType: "test-result-batch", schemaVersion: "2.0.0", producerVersion: "1.0.0", executionId: "EXEC-SAVE", runId: workspace.runId,
      commitSha: "b".repeat(40), specTreeSha256: "c".repeat(64),
      startedAt: "2026-07-23T12:34:56.000Z", finishedAt: "2026-07-23T12:35:56.000Z", entries: overrides.batchEntries,
    } });
  }
  await workspace.close();
  return { root, runId: workspace.runId, workspacePath: workspace.path };
}

async function rewriteRegisteredArtifact(workspacePath: string, type: string, mutate: (value: Record<string, unknown>) => void) {
  const manifestPath = join(workspacePath, "artifact-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; type: string; relativePath: string; sha256: string }[] };
  const record = manifest.artifacts.find((artifact) => artifact.type === type);
  if (!record) throw new Error(`Missing ${type}`);
  const path = join(workspacePath, record.relativePath);
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  mutate(value);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, contents);
  record.sha256 = sha256Text(contents);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("evaluateWorkspaceCoverage", () => {
  it("satisfies an authoritative obligation only from registered immutable planning and passed result artifacts", async () => {
    const fixture = await setup();

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ complete: true, satisfied: ["COV-SAVE"], qualifyingAttemptIds: ["ATTEMPT-SAVE"] });
  });

  it("leaves an inferred requirement unsatisfied", async () => {
    const fixture = await setup({ requirementAuthority: "INFERRED" });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ complete: false, missing: ["COV-SAVE"] });
  });

  it("does not let an agent-draft result satisfy authoritative release coverage", async () => {
    const fixture = await setup({ resultProvenance: "agent-draft" });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ complete: false, missing: ["COV-SAVE"], qualifyingAttemptIds: [] });
  });

  it("lets a runtime-observed (lane 2) result satisfy authoritative release coverage", async () => {
    const fixture = await setup({ resultProvenance: "runtime-observed" });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ complete: true, satisfied: ["COV-SAVE"], qualifyingAttemptIds: ["ATTEMPT-SAVE"] });
  });

  it("does not let an unrelated provenance value satisfy authoritative release coverage", async () => {
    const fixture = await setup({ resultProvenance: "runtime" });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ complete: false, missing: ["COV-SAVE"], qualifyingAttemptIds: [] });
  });

  it("rejects a test-result with stripped provenance at the manifest validation gate", async () => {
    // This test pins an invariant: undefined provenance is unreachable at the coverage-predicate layer
    // because the manifest record's `required: ["provenance"]` alone rejects a record with the key
    // deleted, at the workspace read/validation gate, before creditsCoverage is ever called.
    // (`additionalProperties: false` guards against EXTRA keys, not a missing required one, so it plays
    // no part in catching this deletion.) If this test starts failing, do NOT "fix" it by loosening or
    // dropping `required: ["provenance"]` — that would let a stripped-provenance record reach the
    // coverage predicate, which is exactly the invariant this test exists to block. Investigate why the
    // manifest schema stopped rejecting the deletion instead.
    const fixture = await setup({ resultProvenance: "runtime-observed" });
    const manifestPath = join(fixture.workspacePath, "artifact-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; type: string; relativePath: string; sha256: string; provenance?: string }[] };
    const record = manifest.artifacts.find((artifact) => artifact.type === "test-result");
    if (record) delete record.provenance;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(evaluateWorkspaceCoverage(fixture)).rejects.toThrow(/Invalid artifact manifest/);
  });

  it("does not accept caller-constructed IDs or verification context", async () => {
    const fixture = await setup({ requirementAuthority: "INFERRED" });

    await expect(evaluateWorkspaceCoverage({ ...fixture, authoritativeRequirementIds: ["REQ-SAVE"], verifiedAttemptIds: ["ATTEMPT-SAVE"] } as never))
      .resolves.toMatchObject({ complete: false, missing: ["COV-SAVE"] });
  });

  it("rejects an orphan result reference", async () => {
    const fixture = await setup();
    await rewriteRegisteredArtifact(fixture.workspacePath, "test-result", (result) => { result.testCaseId = "TC-ORPHAN"; });

    await expect(evaluateWorkspaceCoverage(fixture)).rejects.toThrow(/reference|binding|workspace/i);
  });

  it("rejects an exact testcase revision mismatch", async () => {
    const fixture = await setup();
    await rewriteRegisteredArtifact(fixture.workspacePath, "test-result", (result) => { result.testCaseRevisionId = "REV-OTHER"; });

    await expect(evaluateWorkspaceCoverage(fixture)).rejects.toThrow(/revision|reference|binding/i);
  });

  // `browser` is deliberately absent from this list: since CONTEXT.md:442 the attempt's engine comes
  // from what the runtime OBSERVED, so a mismatched declared label on the test case is not a coverage
  // mismatch at all. That whole dimension is covered by "evaluateWorkspaceCoverage — observed engine".
  it.each([
    ["requirement", { requirementId: "REQ-OTHER" }], ["role", { role: "admin" }], ["behavior", { behavior: "delete profile" }],
    ["viewport", { viewport: { width: 390, height: 844 } }], ["accessibility", { accessibilityMethod: "screen-reader" }],
    ["risk", { risk: "low" }], ["outcome", { outcome: "redirected" }],
  ])("does not satisfy on a %s dimension mismatch", async (_dimension, coverage) => {
    const fixture = await setup({ testCase: { coverage } });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ complete: false, missing: ["COV-SAVE"] });
  });

  it("rejects checksum-rewritten obligation or result tampering during reevaluation", async () => {
    const fixture = await setup();
    await rewriteRegisteredArtifact(fixture.workspacePath, "coverage-obligation", (obligation) => { obligation.requirementId = "REQ-TAMPERED"; });
    await expect(evaluateWorkspaceCoverage(fixture)).rejects.toThrow(/orphan|reference|binding|workspace/i);
  });

  it("rejects a checksum-rewritten result that changes its exact instance binding", async () => {
    const fixture = await setup();
    await rewriteRegisteredArtifact(fixture.workspacePath, "test-result", (result) => { result.testCaseInstanceId = "TC-SAVE--TAMPERED"; });

    await expect(evaluateWorkspaceCoverage(fixture)).rejects.toThrow(/instance|reference|binding|workspace/i);
  });

  /** Byte-identity pin: with no batch registered, this reader must return exactly the evaluation it
   *  returned before `test-result-batch` existed. Captured from the pre-change code. */
  it("produces byte-identical coverage output for a workspace containing no batches", async () => {
    const fixture = await setup();

    expect(JSON.stringify(await evaluateWorkspaceCoverage(fixture)))
      .toBe("{\"complete\":true,\"satisfied\":[\"COV-SAVE\"],\"missing\":[],\"qualifyingAttemptIds\":[\"ATTEMPT-SAVE\"]}");
  });
});

/** CONTEXT.md:442 — "A Browser Matrix member is credited from the engine the QA Runtime observed,
 *  never from the engine a test case declared." These run against a REGISTERED, schema-validated
 *  workspace, so `test-result.observedEngine` is a real persisted field and `test-case.coverage.browser`
 *  is a real declared one, and the two can genuinely disagree.
 *
 *  Before this change both readers compared the OBLIGATION's declared engine against the TEST CASE's
 *  declared engine — two declarations agreeing with each other, with the execution never consulted.
 *  The first two tests below are that defect from both sides: the declared label is neither sufficient
 *  (it cannot buy a credit the run did not earn) nor necessary (it cannot veto one the run did earn). */
describe("evaluateWorkspaceCoverage — observed engine", () => {
  it("does not credit a chromium obligation from an attempt that observed firefox, though the test case declares chromium", async () => {
    // obligation.browser === "chromium" === testCase.coverage.browser. Only the OBSERVED engine
    // disagrees — and nothing in this workspace ever ran firefox.
    const fixture = await setup({ result: { observedEngine: "firefox" } });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ complete: false, missing: ["COV-SAVE"], satisfied: [], qualifyingAttemptIds: [] });
  });

  it("credits a firefox obligation from an attempt that observed firefox, though the test case declares chromium", async () => {
    const fixture = await setup({ obligation: { browser: "firefox" }, result: { observedEngine: "firefox" } });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ complete: true, satisfied: ["COV-SAVE"], qualifyingAttemptIds: ["ATTEMPT-SAVE"] });
  });

  it("still credits when only the test case's declared label disagrees, because that label is no longer read", async () => {
    const fixture = await setup({ testCase: { coverage: { browser: "webkit" } } });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ complete: true, satisfied: ["COV-SAVE"], qualifyingAttemptIds: ["ATTEMPT-SAVE"] });
  });

  it("applies the same rule to a lane-2 batch entry, which carries its own observed engine", async () => {
    const entry = {
      entryId: "ENTRY-SAVE", testCaseId: "TC-SAVE", testCaseRevisionId: "REV-SAVE", testCaseInstanceId: "TC-SAVE--INSTANCE-1",
      status: "PASSED", failureClassification: "NONE", steps: [{ stepId: "save", status: "PASSED", durationMs: 1 }],
    };
    const mismatched = await setup({ omitResult: true, batchEntries: [{ ...entry, observedEngine: "firefox" }] });
    const matching = await setup({ omitResult: true, batchEntries: [{ ...entry, observedEngine: "chromium" }] });

    await expect(evaluateWorkspaceCoverage(mismatched)).resolves.toMatchObject({ complete: false, missing: ["COV-SAVE"], qualifyingAttemptIds: [] });
    await expect(evaluateWorkspaceCoverage(matching)).resolves.toMatchObject({ complete: true, satisfied: ["COV-SAVE"], qualifyingAttemptIds: ["ENTRY-SAVE"] });
  });
});

/** CONTEXT.md:443-445 — an obligation on a surface no executor covers is still authorable, and both
 *  coverage readers must agree it is VALID and UNMET. These run against a REGISTERED, schema-validated
 *  workspace, so a non-browser obligation genuinely carries no `browser` and no `viewport`. */
describe("evaluateWorkspaceCoverage — execution surfaces", () => {
  it("resolves a required non-browser obligation instead of rejecting it for the viewport it lacks", async () => {
    const fixture = await setup({ obligationSurface: "api" });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ complete: false, missing: ["COV-SAVE"] });
  });

  it("does not let the passing browser attempt credit an api-surface obligation", async () => {
    const fixture = await setup({ obligationSurface: "api" });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ satisfied: [], qualifyingAttemptIds: [] });
  });

  it("agrees with the release gate's reader that the same registered obligation is valid and unmet", async () => {
    const fixture = await setup({ obligationSurface: "security" });
    const workspace = await RunWorkspace.open(fixture.root, fixture.runId);
    const artifacts = await workspace.readRegisteredArtifacts();
    const gate = deriveReleaseGateFromWorkspaceArtifacts(artifacts);
    await workspace.close();

    // Fail-closed reader: resolves it and reports it missing. Fail-open reader: same conclusion.
    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ missing: ["COV-SAVE"] });
    expect(gate.ruleInputs.coverage.requiredMissing).toEqual(["COV-SAVE"]);
    expect(gate.recommendation).toBe("NOT_READY");
  });
});

/** Lane 2 (ADR-0010): a Runtime-Observed Execution registers one `test-result-batch` holding many
 *  entries. Each entry flattens into a CoverageAttempt keyed by its `entryId`, credited under exactly
 *  the same provenance predicate as a per-attempt `test-result`. */
describe("evaluateWorkspaceCoverage — test-result-batch entries", () => {
  const entry = {
    entryId: "ENTRY-SAVE", testCaseId: "TC-SAVE", testCaseRevisionId: "REV-SAVE", testCaseInstanceId: "TC-SAVE--INSTANCE-1",
    status: "PASSED", failureClassification: "NONE", observedEngine: "chromium", steps: [{ stepId: "save", status: "PASSED", durationMs: 1 }],
  };

  it("credits an authoritative obligation from a runtime-observed batch entry", async () => {
    const fixture = await setup({ omitResult: true, batchEntries: [entry] });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toEqual({ complete: true, satisfied: ["COV-SAVE"], missing: [], qualifyingAttemptIds: ["ENTRY-SAVE"] });
  });

  it("does not let an agent-draft batch satisfy authoritative release coverage", async () => {
    const fixture = await setup({ omitResult: true, batchEntries: [entry], batchProvenance: "agent-draft" });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ complete: false, missing: ["COV-SAVE"], qualifyingAttemptIds: [] });
  });

  it("credits a batch and a per-attempt result together, leaving the per-attempt credit unchanged", async () => {
    const fixture = await setup({ batchEntries: [entry] });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toEqual({
      complete: true, satisfied: ["COV-SAVE"], missing: [], qualifyingAttemptIds: ["ATTEMPT-SAVE", "ENTRY-SAVE"],
    });
  });

  it("does not credit a batch entry that did not pass", async () => {
    const fixture = await setup({ omitResult: true, batchEntries: [{ ...entry, status: "FAILED", failureClassification: "PRODUCT_DEFECT" }] });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ complete: false, missing: ["COV-SAVE"], qualifyingAttemptIds: [] });
  });

  it("rejects a checksum-rewritten batch entry that no longer binds one registered test case", async () => {
    const fixture = await setup({ omitResult: true, batchEntries: [entry] });
    await rewriteRegisteredArtifact(fixture.workspacePath, "test-result-batch", (batch) => {
      (batch.entries as Record<string, unknown>[])[0]!.testCaseRevisionId = "REV-GONE";
    });

    await expect(evaluateWorkspaceCoverage(fixture)).rejects.toThrow(/orphan|reference|binding|workspace/i);
  });
});
