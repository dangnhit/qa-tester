import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Text } from "../../src/core/checksum.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { evaluateWorkspaceCoverage } from "../../src/operations/evaluate-workspace-coverage.js";
import { recordHumanAttestation } from "../../src/operations/record-human-attestation.js";
import { deriveReleaseGateFromWorkspaceArtifacts } from "../../src/reporting/release-gate.js";

const roots: string[] = [];
const environmentProfile = {
  artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0",
  environmentProfileId: "env-test", name: "Test", classification: "test",
  baseUrl: "https://test.example.test", productionReadOnly: false,
} as const;

/** The dimensions an obligation carries on every Execution Surface.
 *
 *  `accessibilityMethod` is `null` — "this obligation names no accessibility method", the common case
 *  and NOT an Accessibility Obligation at all. It was `"keyboard"` until CONTEXT.md:438 was enforced,
 *  which was incidental to every test in this file: none of them is about accessibility, and all of
 *  them assert that a passing ATTEMPT credits COV-SAVE. A manual Accessibility Obligation is now
 *  correctly unsatisfiable by any attempt, so leaving `"keyboard"` here would have silently changed
 *  what eight provenance/observed-engine/batch tests were exercising. The accessibility behaviour has
 *  its own describe block below, which sets the method explicitly. */
const surfacelessDimensions = {
  requirementId: "REQ-SAVE", role: "member", behavior: "save profile",
  accessibilityMethod: null, risk: "high", outcome: "confirmation shown",
} as const;
/** Plus the two only the browser surface owns; `test-case.coverage` always carries both. */
const dimensions = { ...surfacelessDimensions, browser: "chromium", viewport: { width: 1440, height: 900 } } as const;

async function setup(overrides: {
  requirementAuthority?: string; result?: Record<string, unknown>; resultProvenance?: string;
  testCase?: Record<string, unknown>; obligation?: Record<string, unknown>; obligationSurface?: string;
  omitResult?: boolean; batchEntries?: readonly Record<string, unknown>[]; batchProvenance?: string;
  /** A SECOND registered coverage obligation over the same authoritative requirement. */
  extraObligation?: Record<string, unknown>;
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
  if (overrides.extraObligation !== undefined) {
    await register("coverage-obligation", {
      artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0", obligationId: "COV-OTHER", requirementAnalysisArtifactId: requirement.id,
      executionSurface: surface, ...(surface === "browser" ? dimensions : surfacelessDimensions), required: true, ...overrides.extraObligation,
    });
  }
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
      artifactType: "test-result-batch", schemaVersion: "3.0.0", producerVersion: "1.0.0", executionId: "EXEC-SAVE", runId: workspace.runId,
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
  //
  // `accessibility` was removed from this list for the same reason, one rule later: since
  // CONTEXT.md:439 an attempt cannot address an Accessibility Obligation at all, so the test case's
  // declared method is not a coverage dimension either — it can no more veto a credit than buy one.
  // Both halves of that are pinned in "evaluateWorkspaceCoverage — accessibility obligations" below.
  it.each([
    ["requirement", { requirementId: "REQ-OTHER" }], ["role", { role: "admin" }], ["behavior", { behavior: "delete profile" }],
    ["viewport", { viewport: { width: 390, height: 844 } }],
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
      status: "PASSED", failureClassification: "NONE", executionSurface: "browser", viewport: dimensions.viewport,
      steps: [{ stepId: "save", status: "PASSED", durationMs: 1 }],
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

/**
 * CONTEXT.md:438-439 — an Accessibility Obligation is satisfied only by the artifact its method calls
 * for, and never by a declared evaluation method matching its own label. These run against a
 * REGISTERED, schema-validated workspace, so the obligation's `accessibilityMethod`, the test case's
 * declared one, and the `human-attestation` are all real persisted artifacts written by the shipped
 * producer — no hand-built record stands in for any of them.
 *
 * This reader is the fail-CLOSED one: it rejects a malformed record rather than dropping it. An
 * attestation is the one input where that distinction cannot arise, because a malformed attestation
 * can only ever WITHHOLD credit, never grant it — the closed direction already.
 */
describe("evaluateWorkspaceCoverage — accessibility obligations", () => {
  const attested = {
    method: "screen-reader", attestedBy: "reviewer@example.test",
    statement: "Drove the whole save-profile flow with VoiceOver; every control was announced with its role and current state.",
  };
  /** A manual Accessibility Obligation whose test case declares the very same method. */
  const screenReader = { obligation: { accessibilityMethod: "screen-reader" }, testCase: { coverage: { accessibilityMethod: "screen-reader" } } };

  it("does not credit a screen-reader obligation from a passing attempt whose test case declares screen-reader", async () => {
    // THE KILL: two declared labels agreeing with each other. No screen reader, no human, and no
    // human-attestation artifact exists anywhere in this workspace.
    const fixture = await setup(screenReader);

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({
      complete: false, missing: ["COV-SAVE"], satisfied: [], qualifyingAttemptIds: [],
    });
  });

  it("credits it once a Human Attestation for that obligation is registered", async () => {
    const fixture = await setup(screenReader);

    await recordHumanAttestation({ root: fixture.root, runId: fixture.runId, obligationId: "COV-SAVE", ...attested });

    // The passing ATTEMPT-SAVE is still registered and still passing; it contributes nothing, because
    // an attestation contains no attempt for `qualifyingAttemptIds` to report.
    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toEqual({
      complete: true, satisfied: ["COV-SAVE"], missing: [], qualifyingAttemptIds: [],
    });
  });

  it("credits it from the attestation alone, with no passing attempt registered at all", async () => {
    const fixture = await setup({ ...screenReader, omitResult: true });

    await recordHumanAttestation({ root: fixture.root, runId: fixture.runId, obligationId: "COV-SAVE", ...attested });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toEqual({
      complete: true, satisfied: ["COV-SAVE"], missing: [], qualifyingAttemptIds: [],
    });
  });

  it("does not let an attestation bound to a different obligation satisfy this one", async () => {
    const fixture = await setup({ ...screenReader, extraObligation: { obligationId: "COV-OTHER", behavior: "delete profile", accessibilityMethod: "screen-reader" } });

    await recordHumanAttestation({ root: fixture.root, runId: fixture.runId, obligationId: "COV-OTHER", ...attested });

    // Same run, same method, same attester — but the attestation names COV-OTHER's exact immutable
    // bytes, so COV-SAVE stays unmet.
    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({
      complete: false, satisfied: ["COV-OTHER"], missing: ["COV-SAVE"],
    });
  });

  /**
   * The provenance guard, mirroring `creditsCoverage` on the attempt paths. Everything else about this
   * attestation is exactly what `recordHumanAttestation` would have written — same obligation bytes,
   * same method, same substantive statement, and it satisfies `humanAttestationRule` on the WRITE path
   * (it registers without error) — so the only thing left to decide it is the manifest stamp.
   * `agent-draft` is the value `registerArtifactValue` defaults to when nothing supplies a provenance,
   * i.e. exactly what an attestation payload that did not come from that operation carries.
   *
   * Both readers are asserted here off the ONE registered workspace, because the fail-CLOSED and
   * fail-OPEN readers must reach the same verdict on it and only a shared fixture proves that.
   */
  it("does not credit an attestation whose provenance is not human-attestation:<identity>", async () => {
    const fixture = await setup({ ...screenReader, omitResult: true });
    const workspace = await RunWorkspace.open(fixture.root, fixture.runId);
    const obligation = (await workspace.readRegisteredArtifacts()).find((artifact) => artifact.record.type === "coverage-obligation");
    if (!obligation) throw new Error("Missing coverage-obligation");
    await workspace.registerArtifactValue({
      type: "human-attestation", relationships: [obligation.record.id], provenance: "agent-draft",
      value: {
        artifactType: "human-attestation", schemaVersion: "1.0.0", producerVersion: "1.0.0", attestationId: "ATTESTATION-FORGED",
        runId: workspace.runId, obligationId: "COV-SAVE", obligationSha256: obligation.record.sha256, method: "screen-reader",
        attestedBy: "reviewer@example.test", attestedAt: "2026-07-25T09:00:00.000Z", statement: attested.statement,
      },
    });
    const artifacts = await workspace.readRegisteredArtifacts();
    const gate = deriveReleaseGateFromWorkspaceArtifacts(artifacts);
    await workspace.close();

    // It really is registered and really is readable — it just earns nothing.
    expect(artifacts.some((artifact) => artifact.record.type === "human-attestation")).toBe(true);
    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ complete: false, missing: ["COV-SAVE"], satisfied: [] });
    expect(gate.ruleInputs.coverage.requiredMissing).toEqual(["COV-SAVE"]);
    expect(gate.recommendation).toBe("NOT_READY");
  });

  it("still credits a null-method obligation whose test case declares a method of its own", async () => {
    // The replacement for the `accessibility` row removed from the dimension-mismatch table above,
    // and the mirror of the kill test: the obligation asks for no accessibility evaluation, so the
    // test case's declared method is a fact about the test case that this reader no longer consults.
    const fixture = await setup({ testCase: { coverage: { accessibilityMethod: "screen-reader" } } });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({
      complete: true, satisfied: ["COV-SAVE"], qualifyingAttemptIds: ["ATTEMPT-SAVE"],
    });
  });

  it("leaves an automated-analysis obligation unmet, with no artifact in this repo able to satisfy it", async () => {
    // No accessibility scanner exists here — no dependency, no import, no evidence kind for a scan
    // result — so the obligation is EXPLICITLY UNMET, exactly like Task 32's unexecutable surfaces.
    // The two rejections below close the only other door: a person cannot stand in for the machine.
    const fixture = await setup({ obligation: { accessibilityMethod: "automated-analysis" }, testCase: { coverage: { accessibilityMethod: "automated-analysis" } } });

    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ complete: false, missing: ["COV-SAVE"], satisfied: [] });
    await expect(recordHumanAttestation({ root: fixture.root, runId: fixture.runId, obligationId: "COV-SAVE", ...attested, method: "automated-analysis" }))
      .rejects.toThrow(/manual evaluation only/i);
    await expect(recordHumanAttestation({ root: fixture.root, runId: fixture.runId, obligationId: "COV-SAVE", ...attested }))
      .rejects.toThrow(/method must equal/i);
    await expect(evaluateWorkspaceCoverage(fixture)).resolves.toMatchObject({ complete: false, missing: ["COV-SAVE"] });
  });
});

/** Lane 2 (ADR-0010): a Runtime-Observed Execution registers one `test-result-batch` holding many
 *  entries. Each entry flattens into a CoverageAttempt keyed by its `entryId`, credited under exactly
 *  the same provenance predicate as a per-attempt `test-result`. */
describe("evaluateWorkspaceCoverage — test-result-batch entries", () => {
  /** Everything an entry carries no matter which Execution Surface it ran on. */
  const surfacelessEntry = {
    entryId: "ENTRY-SAVE", testCaseId: "TC-SAVE", testCaseRevisionId: "REV-SAVE", testCaseInstanceId: "TC-SAVE--INSTANCE-1",
    status: "PASSED", failureClassification: "NONE", steps: [{ stepId: "save", status: "PASSED", durationMs: 1 }],
  };
  /** A browser entry that OBSERVED exactly what the bound test case DECLARED. The two agreeing is what
   *  makes this fixture credit COV-SAVE; the tests below that break the agreement prove the entry's own
   *  values are what is compared, not the test case's. */
  const entry = { ...surfacelessEntry, executionSurface: "browser", observedEngine: dimensions.browser, viewport: dimensions.viewport };

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

/**
 * Task 36 — a batch entry's Execution Surface and viewport come from the ENTRY, never from the test
 * case it binds.
 *
 * Until schema 3.0.0 both readers flattened every batch entry with a hardcoded
 * `executionSurface: "browser"` and a viewport lifted from `test-case.coverage` — the geometry the
 * plan DECLARED. Nothing measured sat between those two labels, so a unit or api suite's entry could
 * satisfy a browser obligation it never ran, and any entry could satisfy a geometry nothing rendered
 * at. That is the shape CONTEXT.md:441 forbids ("never satisfied by another engine OR VIEWPORT") and
 * the one Phase 6 already removed for the engine.
 *
 * Lane 1 keeps deriving both, and correctly: `createBrowserAttemptSession` SETS the live context's
 * viewport from `test-case.coverage.viewport` before the attempt runs, and the DSL action union has no
 * resize or emulation action, so there the declaration is causally UPSTREAM of the geometry rather
 * than an independent claim about it. The last two tests pin that lane 1 is untouched.
 *
 * Every test here asserts BOTH readers off the ONE registered, schema-validated workspace. They keep
 * their different failure philosophies (`evaluateWorkspaceCoverage` throws, the release gate drops)
 * and must still reach the same verdict; only a shared fixture proves that.
 */
describe("evaluateWorkspaceCoverage — a batch entry's own Execution Surface and viewport", () => {
  const surfacelessEntry = {
    entryId: "ENTRY-SAVE", testCaseId: "TC-SAVE", testCaseRevisionId: "REV-SAVE", testCaseInstanceId: "TC-SAVE--INSTANCE-1",
    status: "PASSED", failureClassification: "NONE", steps: [{ stepId: "save", status: "PASSED", durationMs: 1 }],
  };
  const browserEntry = { ...surfacelessEntry, executionSurface: "browser", observedEngine: dimensions.browser, viewport: dimensions.viewport };

  /** The verdict of both readers over one workspace: what the fail-CLOSED reader resolved, and what
   *  the fail-OPEN release-gate reader made of the very same registered artifacts. */
  async function bothReaders(fixture: { root: string; runId: string }) {
    const workspace = await RunWorkspace.open(fixture.root, fixture.runId);
    const gate = deriveReleaseGateFromWorkspaceArtifacts(await workspace.readRegisteredArtifacts());
    await workspace.close();
    return { coverage: await evaluateWorkspaceCoverage(fixture), gate };
  }

  /** THE test this task exists for. The entry ran an api suite. Its bound test case declares a full
   *  browser coverage block — engine, viewport, the lot — and the obligation matches that declaration
   *  on every single dimension. Before this change the entry was stamped `browser` and handed the test
   *  case's declared viewport, so it credited a browser obligation no browser ever satisfied. */
  it("does not let an api entry satisfy the browser obligation its bound test case declares dimensions for", async () => {
    const fixture = await setup({ omitResult: true, batchEntries: [{ ...surfacelessEntry, executionSurface: "api" }] });

    const { coverage, gate } = await bothReaders(fixture);

    expect(coverage).toMatchObject({ complete: false, missing: ["COV-SAVE"], satisfied: [], qualifyingAttemptIds: [] });
    expect(gate.ruleInputs.coverage.requiredMissing).toEqual(["COV-SAVE"]);
    expect(gate.recommendation).toBe("NOT_READY");
  });

  /** The control for the test above: the SAME workspace with the SAME entry on the browser surface
   *  credits, so the only reason the api entry did not is the surface it declared. */
  it("credits the same obligation from the same entry once it declares the browser surface it ran on", async () => {
    const fixture = await setup({ omitResult: true, batchEntries: [browserEntry] });

    const { coverage, gate } = await bothReaders(fixture);

    expect(coverage).toMatchObject({ complete: true, satisfied: ["COV-SAVE"], qualifyingAttemptIds: ["ENTRY-SAVE"] });
    expect(gate.ruleInputs.coverage.requiredMissing).toEqual([]);
  });

  /** The capability the read unlocks: a surface the QA Runtime cannot execute is reached through a
   *  Runtime-Observed Execution (CONTEXT.md:444) and stops being permanently unmet. */
  it("credits a non-browser obligation from an entry that ran that same non-browser surface", async () => {
    const fixture = await setup({ obligationSurface: "api", omitResult: true, batchEntries: [{ ...surfacelessEntry, executionSurface: "api" }] });

    const { coverage, gate } = await bothReaders(fixture);

    expect(coverage).toMatchObject({ complete: true, satisfied: ["COV-SAVE"], qualifyingAttemptIds: ["ENTRY-SAVE"] });
    expect(gate.ruleInputs.coverage.requiredMissing).toEqual([]);
  });

  it("does not let an entry on one non-browser surface satisfy an obligation on another", async () => {
    const fixture = await setup({ obligationSurface: "api", omitResult: true, batchEntries: [{ ...surfacelessEntry, executionSurface: "unit" }] });

    const { coverage, gate } = await bothReaders(fixture);

    expect(coverage).toMatchObject({ complete: false, missing: ["COV-SAVE"], qualifyingAttemptIds: [] });
    expect(gate.ruleInputs.coverage.requiredMissing).toEqual(["COV-SAVE"]);
  });

  /** The viewport half. The obligation and the test case both declare 1440x900; the entry reports the
   *  geometry it actually rendered at. Before this change the entry's own value was never read, so the
   *  declared 1440x900 was compared to itself and this credited. */
  it("does not credit a browser entry whose own viewport differs from the obligation's", async () => {
    const fixture = await setup({ omitResult: true, batchEntries: [{ ...browserEntry, viewport: { width: 390, height: 844 } }] });

    const { coverage, gate } = await bothReaders(fixture);

    expect(coverage).toMatchObject({ complete: false, missing: ["COV-SAVE"], qualifyingAttemptIds: [] });
    expect(gate.ruleInputs.coverage.requiredMissing).toEqual(["COV-SAVE"]);
  });

  /** The mirror: the entry's viewport is what is compared, so an obligation asking for the geometry the
   *  entry REPORTED is credited even though the test case declares a different one. */
  it("credits an obligation matching the entry's reported viewport though the test case declares another", async () => {
    const mobile = { width: 390, height: 844 };
    const fixture = await setup({ obligation: { viewport: mobile }, omitResult: true, batchEntries: [{ ...browserEntry, viewport: mobile }] });

    const { coverage, gate } = await bothReaders(fixture);

    expect(coverage).toMatchObject({ complete: true, satisfied: ["COV-SAVE"], qualifyingAttemptIds: ["ENTRY-SAVE"] });
    expect(gate.ruleInputs.coverage.requiredMissing).toEqual([]);
  });

  /** Lane 1, unchanged: a `test-result` still derives `browser` and still takes its viewport from the
   *  test case's declaration — which is why moving the DECLARED viewport away from the obligation's
   *  stops lane 1 crediting. A `test-result` carries no surface and no viewport of its own; if either
   *  reader ever started reading one off the claim, this pair would flip. */
  it("still derives lane 1's surface and viewport from the declaration, not from the test result", async () => {
    const declared = await setup({ obligation: { viewport: { width: 390, height: 844 } } });
    const matching = await setup();

    await expect(bothReaders(declared)).resolves.toMatchObject({
      coverage: { complete: false, missing: ["COV-SAVE"], qualifyingAttemptIds: [] },
      gate: { ruleInputs: { coverage: { requiredMissing: ["COV-SAVE"] } } },
    });
    await expect(bothReaders(matching)).resolves.toMatchObject({
      coverage: { complete: true, satisfied: ["COV-SAVE"], qualifyingAttemptIds: ["ATTEMPT-SAVE"] },
      gate: { ruleInputs: { coverage: { requiredMissing: [] } } },
    });
  });

  it("still refuses lane 1 credit for any non-browser obligation, because the runtime drove a browser", async () => {
    const fixture = await setup({ obligationSurface: "api" });

    const { coverage, gate } = await bothReaders(fixture);

    expect(coverage).toMatchObject({ complete: false, missing: ["COV-SAVE"], qualifyingAttemptIds: [] });
    expect(gate.ruleInputs.coverage.requiredMissing).toEqual(["COV-SAVE"]);
  });

  /** Fail-CLOSED, end to end: an entry's surface cannot be quietly edited into one that credits more.
   *  The rejection comes from the contract gate `readRegisteredArtifacts` applies before either reader
   *  sees the record — `executionSurface` is an enum and a browser entry's viewport is required — so
   *  the surface read in `dimensions()` is defence in depth behind it, exactly like the identical
   *  unreachable throw `asObligation` already carries for an obligation's surface. */
  it.each([
    ["a surface outside the enum", (entry: Record<string, unknown>) => { entry.executionSurface = "e2e"; }],
    ["a browser entry stripped of its viewport", (entry: Record<string, unknown>) => { delete entry.viewport; }],
    ["a viewport smuggled onto an api entry", (entry: Record<string, unknown>) => { entry.executionSurface = "api"; delete entry.observedEngine; }],
  ] as const)("rejects a checksum-rewritten batch declaring %s", async (_label, tamper) => {
    const fixture = await setup({ omitResult: true, batchEntries: [browserEntry] });
    await rewriteRegisteredArtifact(fixture.workspacePath, "test-result-batch", (batch) => {
      tamper((batch.entries as Record<string, unknown>[])[0]!);
    });

    await expect(evaluateWorkspaceCoverage(fixture)).rejects.toThrow(/contract|surface|viewport|binding|workspace/i);
  });
});
