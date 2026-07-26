import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Text } from "../../src/core/checksum.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { evaluateWorkspaceCoverage } from "../../src/operations/evaluate-workspace-coverage.js";

const roots: string[] = [];
const environmentProfile = {
  artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0",
  environmentProfileId: "env-test", name: "Test", classification: "test",
  baseUrl: "https://test.example.test", productionReadOnly: false,
} as const;

const dimensions = {
  requirementId: "REQ-SAVE", role: "member", behavior: "save profile", browser: "chromium",
  viewport: { width: 1440, height: 900 }, accessibilityMethod: "keyboard", risk: "high", outcome: "confirmation shown",
} as const;

async function setup(overrides: {
  requirementAuthority?: string; result?: Record<string, unknown>; resultProvenance?: string;
  testCase?: Record<string, unknown>; obligation?: Record<string, unknown>;
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
  await register("coverage-obligation", {
    artifactType: "coverage-obligation", schemaVersion: "1.0.0", producerVersion: "1.0.0", obligationId: "COV-SAVE", requirementAnalysisArtifactId: requirement.id,
    ...dimensions, required: true, ...overrides.obligation,
  });
  const { coverage: coverageOverride, ...testCaseOverrides } = overrides.testCase ?? {};
  const testCase = await register("test-case", {
    artifactType: "test-case", schemaVersion: "1.0.0", producerVersion: "1.0.0", testCaseId: "TC-SAVE", revisionId: "REV-SAVE", instanceId: "TC-SAVE--INSTANCE-1", title: "Saves a profile",
    steps: [{ id: "save", action: "click", sideEffect: "none" }], coverage: { ...dimensions, ...(coverageOverride ?? {}) }, ...testCaseOverrides,
  });
  if (overrides.omitResult !== true) {
    await workspace.registerArtifactValue({ type: "test-result", relationships: [testCase.id], provenance: overrides.resultProvenance ?? "runtime-execution", value: {
      artifactType: "test-result", schemaVersion: "1.0.0", producerVersion: "1.0.0", attemptId: "ATTEMPT-SAVE", runId: workspace.runId, testCaseId: "TC-SAVE", testCaseRevisionId: "REV-SAVE", testCaseInstanceId: "TC-SAVE--INSTANCE-1", status: "PASSED", failureClassification: "NONE", steps: [{ stepId: "save", status: "PASSED", durationMs: 1 }], startedAt: "2026-07-23T12:34:56.000Z", finishedAt: "2026-07-23T12:35:56.000Z", ...overrides.result,
    } });
  }
  if (overrides.batchEntries !== undefined) {
    await workspace.registerArtifactValue({ type: "test-result-batch", relationships: [testCase.id], provenance: overrides.batchProvenance ?? "runtime-observed", value: {
      artifactType: "test-result-batch", schemaVersion: "1.0.0", producerVersion: "1.0.0", executionId: "EXEC-SAVE", runId: workspace.runId,
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
    // because the artifact-manifest schema (additionalProperties: false, required: ["provenance"], minLength: 1)
    // rejects it at the workspace read/validation gate before creditsCoverage is ever called.
    // If future changes loosen the manifest schema, this test will fail and should be revisited.
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

  it.each([
    ["requirement", { requirementId: "REQ-OTHER" }], ["role", { role: "admin" }], ["behavior", { behavior: "delete profile" }],
    ["browser", { browser: "webkit" }], ["viewport", { viewport: { width: 390, height: 844 } }], ["accessibility", { accessibilityMethod: "screen-reader" }],
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

/** Lane 2 (ADR-0010): a Runtime-Observed Execution registers one `test-result-batch` holding many
 *  entries. Each entry flattens into a CoverageAttempt keyed by its `entryId`, credited under exactly
 *  the same provenance predicate as a per-attempt `test-result`. */
describe("evaluateWorkspaceCoverage — test-result-batch entries", () => {
  const entry = {
    entryId: "ENTRY-SAVE", testCaseId: "TC-SAVE", testCaseRevisionId: "REV-SAVE", testCaseInstanceId: "TC-SAVE--INSTANCE-1",
    status: "PASSED", failureClassification: "NONE", steps: [{ stepId: "save", status: "PASSED", durationMs: 1 }],
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
