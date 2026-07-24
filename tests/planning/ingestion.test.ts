import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RunWorkspace } from "../../src/core/run-workspace.js";
import { sha256Text } from "../../src/core/checksum.js";
import { ingestRequirementAnalysis } from "../../src/operations/ingest-requirement-analysis.js";
import { ingestTestCases } from "../../src/operations/ingest-testcases.js";
import { ingestCoverageObligation } from "../../src/operations/ingest-coverage-obligation.js";

const roots: string[] = [];

const environmentProfile = {
  artifactType: "environment-profile",
  schemaVersion: "1.0.0",
  producerVersion: "1.0.0",
  environmentProfileId: "env-test",
  name: "Test",
  classification: "test",
  baseUrl: "https://test.example.test",
  productionReadOnly: false,
} as const;

function requirementAnalysis(statementOverrides: Record<string, unknown> = {}) {
  return {
    artifactType: "requirement-analysis",
    schemaVersion: "1.0.0",
    producerVersion: "1.0.0",
    requirementAnalysisId: "RA-1",
    statements: [{
      requirementId: "REQ-LOGIN",
      sourceProvenance: { kind: "user", reference: "ticket-1" },
      normalizedText: "Users must reach the account page after signing in.",
      authority: "AUTHORITATIVE",
      role: "member",
      rules: ["valid credentials"],
      risks: [],
      assumptions: [],
      openQuestions: [],
      ...statementOverrides,
    }],
  };
}

function testPlan(requirementId = "REQ-LOGIN", authority = "AUTHORITATIVE") {
  return {
    artifactType: "test-plan",
    schemaVersion: "1.0.0",
    producerVersion: "1.0.0",
    testPlanId: "PLAN-LOGIN",
    approvalPolicy: { mode: "human-review" },
    testCases: [{
      testCaseId: "TC-LOGIN",
      title: "Signs in",
      expectedResults: [{ id: "ER-LOGIN", requirementId, authority, text: "The account page opens." }],
      steps: [{ id: "open", action: { kind: "navigate", url: "/login" }, sideEffect: "none" }],
      openQuestions: [],
    }],
  };
}

async function setup(profile: Record<string, unknown> = environmentProfile) {
  const root = await mkdtemp(join(tmpdir(), "qa-skills-planning-"));
  roots.push(root);
  const workspace = await RunWorkspace.create({ root, mode: "plan", environmentProfile: profile });
  await workspace.close();
  return { root, runId: workspace.runId, workspacePath: workspace.path };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("planning ingestion", () => {
  it("registers provenance-marked requirement and testcase Agent Drafts", async () => {
    const fixture = await setup();
    const requirementPath = join(fixture.root, "requirements.json");
    const planPath = join(fixture.root, "plan.json");
    await writeFile(requirementPath, JSON.stringify(requirementAnalysis()));
    await writeFile(planPath, JSON.stringify(testPlan()));

    const requirement = await ingestRequirementAnalysis({ ...fixture, sourcePath: requirementPath });
    const plan = await ingestTestCases({ ...fixture, sourcePath: planPath });
    const manifest = JSON.parse(await readFile(join(fixture.workspacePath, "artifact-manifest.json"), "utf8")) as { artifacts: { id: string; provenance: string }[] };

    expect(requirement.provenance).toBe("agent-draft");
    expect(plan.provenance).toBe("agent-draft");
    expect(manifest.artifacts.find((artifact) => artifact.id === plan.id)?.provenance).toBe("agent-draft");
  });

  it("rejects testcase expected results that do not reference a registered requirement", async () => {
    const fixture = await setup();
    const planPath = join(fixture.root, "orphan-plan.json");
    await writeFile(planPath, JSON.stringify(testPlan("REQ-ORPHAN")));

    await expect(ingestTestCases({ ...fixture, sourcePath: planPath })).rejects.toThrow(/orphan.*expected result/i);
  });

  it("rejects unsafe auto-approval instead of promoting an Agent Draft", async () => {
    const fixture = await setup();
    const requirementPath = join(fixture.root, "requirements.json");
    const planPath = join(fixture.root, "unsafe-plan.json");
    await writeFile(requirementPath, JSON.stringify(requirementAnalysis({
      sourceProvenance: { kind: "code", reference: "controller.ts" },
      authority: "INFERRED",
    })));
    const plan = testPlan("REQ-LOGIN", "INFERRED");
    plan.approvalPolicy = { mode: "auto-approve-safe" };
    await writeFile(planPath, JSON.stringify(plan));
    await ingestRequirementAnalysis({ ...fixture, sourcePath: requirementPath });

    await expect(ingestTestCases({
      ...fixture,
      sourcePath: planPath,
      policy: { mode: "auto-approve-safe" },
    })).rejects.toThrow(/unsafe auto-approval/i);
  });

  it("derives a production target from the registered environment before evaluating auto-approval", async () => {
    const fixture = await setup({ ...environmentProfile, classification: "production", productionReadOnly: true });
    const requirementPath = join(fixture.root, "requirements.json");
    const planPath = join(fixture.root, "safe-plan.json");
    await writeFile(requirementPath, JSON.stringify(requirementAnalysis()));
    const plan = testPlan();
    plan.approvalPolicy = { mode: "auto-approve-safe" };
    await writeFile(planPath, JSON.stringify(plan));
    await ingestRequirementAnalysis({ ...fixture, sourcePath: requirementPath });

    await expect(ingestTestCases({
      ...fixture,
      sourcePath: planPath,
      policy: { mode: "auto-approve-safe" },
    })).rejects.toThrow(/unsafe auto-approval.*production-target/i);
  });

  it("rejects requirement authority that disagrees with its code provenance", async () => {
    const fixture = await setup();
    const requirementPath = join(fixture.root, "code-as-authoritative.json");
    await writeFile(requirementPath, JSON.stringify(requirementAnalysis({
      sourceProvenance: { kind: "code", reference: "controller.ts" },
      authority: "AUTHORITATIVE",
    })));

    await expect(ingestRequirementAnalysis({ ...fixture, sourcePath: requirementPath })).rejects.toThrow(/authority.*provenance|provenance.*authority/i);
  });

  it("rejects a direct low-level registration that bypasses requirement authority verification", async () => {
    const fixture = await setup();
    const sourcePath = join(fixture.root, "direct-invalid-requirement.json");
    await writeFile(sourcePath, JSON.stringify(requirementAnalysis({
      sourceProvenance: { kind: "code", reference: "controller.ts" },
      authority: "AUTHORITATIVE",
    })));
    const workspace = await RunWorkspace.open(fixture.root, fixture.runId);

    await expect(workspace.registerArtifact({ type: "requirement-analysis", sourcePath, relationships: [] }))
      .rejects.toThrow(/authority.*provenance|provenance.*authority/i);
    await workspace.close();
  });

  it("uses registered requirement authority rather than a testcase self-declaration", async () => {
    const fixture = await setup();
    const requirementPath = join(fixture.root, "inferred-requirement.json");
    const planPath = join(fixture.root, "self-authoritative-plan.json");
    await writeFile(requirementPath, JSON.stringify(requirementAnalysis({
      sourceProvenance: { kind: "code", reference: "controller.ts" },
      authority: "INFERRED",
    })));
    const plan = testPlan();
    plan.approvalPolicy = { mode: "auto-approve-safe" };
    await writeFile(planPath, JSON.stringify(plan));
    await ingestRequirementAnalysis({ ...fixture, sourcePath: requirementPath });

    await expect(ingestTestCases({ ...fixture, sourcePath: planPath, policy: { mode: "auto-approve-safe" } }))
      .rejects.toThrow(/expected authority.*registered requirement|authority.*mismatch/i);
  });

  it("rejects a human-review testcase whose claimed authority differs from its registered requirement", async () => {
    const fixture = await setup();
    const requirementPath = join(fixture.root, "inferred-requirement.json");
    const planPath = join(fixture.root, "human-mismatch-plan.json");
    await writeFile(requirementPath, JSON.stringify(requirementAnalysis({
      sourceProvenance: { kind: "code", reference: "controller.ts" },
      authority: "INFERRED",
    })));
    await writeFile(planPath, JSON.stringify(testPlan()));
    await ingestRequirementAnalysis({ ...fixture, sourcePath: requirementPath });

    await expect(ingestTestCases({ ...fixture, sourcePath: planPath }))
      .rejects.toThrow(/expected authority.*registered requirement|authority.*mismatch/i);
  });

  it("rejects a direct test-plan registration that would self-approve against an inferred requirement", async () => {
    const fixture = await setup();
    const requirementPath = join(fixture.root, "inferred-requirement.json");
    const planPath = join(fixture.root, "direct-self-authoritative-plan.json");
    await writeFile(requirementPath, JSON.stringify(requirementAnalysis({
      sourceProvenance: { kind: "code", reference: "controller.ts" },
      authority: "INFERRED",
    })));
    const plan = testPlan();
    plan.approvalPolicy = { mode: "auto-approve-safe" };
    await writeFile(planPath, JSON.stringify(plan));
    await ingestRequirementAnalysis({ ...fixture, sourcePath: requirementPath });
    const workspace = await RunWorkspace.open(fixture.root, fixture.runId);

    await expect(workspace.registerArtifact({ type: "test-plan", sourcePath: planPath, relationships: [] }))
      .rejects.toThrow(/expected authority.*registered requirement|authority.*mismatch/i);
    await workspace.close();
  });

  it("rejects an invalid bounded action even when a draft claims it is valid", async () => {
    const fixture = await setup();
    const requirementPath = join(fixture.root, "requirements.json");
    const planPath = join(fixture.root, "invalid-action-plan.json");
    await writeFile(requirementPath, JSON.stringify(requirementAnalysis()));
    const plan = testPlan();
    const step = plan.testCases[0]?.steps[0];
    if (!step) throw new Error("Expected test plan step");
    (step as { action: unknown }).action = { kind: "evaluate", script: "return document.cookie" };
    await writeFile(planPath, JSON.stringify(plan));
    await ingestRequirementAnalysis({ ...fixture, sourcePath: requirementPath });

    await expect(ingestTestCases({ ...fixture, sourcePath: planPath })).rejects.toThrow(/test plan contract|action/i);
  });

  it("rejects a checksum-rewritten persisted requirement whose authority no longer matches provenance", async () => {
    const fixture = await setup();
    const sourcePath = join(fixture.root, "code-requirement.json");
    await writeFile(sourcePath, JSON.stringify(requirementAnalysis({
      sourceProvenance: { kind: "code", reference: "controller.ts" },
      authority: "INFERRED",
    })));
    const registered = await ingestRequirementAnalysis({ ...fixture, sourcePath });
    const tampered = requirementAnalysis({
      sourceProvenance: { kind: "code", reference: "controller.ts" },
      authority: "AUTHORITATIVE",
    });
    const contents = `${JSON.stringify(tampered, null, 2)}\n`;
    await writeFile(registered.absolutePath, contents);
    const manifestPath = join(fixture.workspacePath, "artifact-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; sha256: string }[] };
    const record = manifest.artifacts.find((artifact) => artifact.id === registered.id);
    if (!record) throw new Error("Expected registered requirement");
    record.sha256 = sha256Text(contents);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(RunWorkspace.open(fixture.root, fixture.runId)).rejects.toThrow(/authority.*provenance|provenance.*authority/i);
  });

  it("registers the parsed value rather than rereading a source that changes afterward", async () => {
    const fixture = await setup();
    const sourcePath = join(fixture.root, "stable-snapshot.json");
    const valid = requirementAnalysis();
    await writeFile(sourcePath, JSON.stringify(valid));
    const { readAgentDraft } = await import("../../src/operations/ingest-requirement-analysis.js");
    const parsed = await readAgentDraft(sourcePath);
    await writeFile(sourcePath, JSON.stringify({ ...valid, statements: [] }));
    const workspace = await RunWorkspace.open(fixture.root, fixture.runId);
    const registered = await workspace.registerArtifactValue({
      type: "requirement-analysis",
      value: parsed,
      relationships: [],
    });
    await workspace.close();

    expect(JSON.parse(await readFile(registered.absolutePath, "utf8"))).toEqual(valid);
  });

  it("snapshots a value before its queued manifest transaction can observe caller mutation", async () => {
    const fixture = await setup();
    const workspace = await RunWorkspace.open(fixture.root, fixture.runId);
    const value = requirementAnalysis();
    const registered = workspace.registerArtifactValue({ type: "requirement-analysis", value, relationships: [] });
    const statement = value.statements[0];
    if (!statement) throw new Error("Expected requirement statement");
    statement.normalizedText = "Users might see something else.";
    statement.authority = "ASSUMED";
    const result = await registered;
    await workspace.close();

    expect(JSON.parse(await readFile(result.absolutePath, "utf8"))).toEqual(requirementAnalysis());
  });

  it("rejects an orphan coverage obligation instead of accepting its self-attested requirement", async () => {
    const fixture = await setup();
    const sourcePath = join(fixture.root, "orphan-coverage.json");
    await writeFile(sourcePath, JSON.stringify({
      artifactType: "coverage-obligation", schemaVersion: "1.0.0", producerVersion: "1.0.0",
      obligationId: "COV-1", requirementId: "REQ-ORPHAN", requirementAnalysisArtifactId: "missing-artifact",
      role: "member", behavior: "sign in", browser: "chromium", viewport: { width: 1440, height: 900 }, accessibilityMethod: null, risk: "high", required: true, outcome: "account page opens",
    }));

    await expect(ingestCoverageObligation({ ...fixture, sourcePath })).rejects.toThrow(/orphan|requirement/i);
  });

  it("names the offending field when a requirement analysis draft fails schema validation", async () => {
    const fixture = await setup();
    const sourcePath = join(fixture.root, "invalid-requirement.json");
    const draft = requirementAnalysis();
    const statement = draft.statements[0] as Record<string, unknown>;
    delete statement.normalizedText;
    await writeFile(sourcePath, JSON.stringify(draft));

    await expect(ingestRequirementAnalysis({ ...fixture, sourcePath })).rejects.toThrow(/normalizedText/);
  });

  it("rejects a checksum-rewritten persisted coverage obligation that no longer binds its requirement", async () => {
    const fixture = await setup();
    const requirementPath = join(fixture.root, "requirements.json");
    await writeFile(requirementPath, JSON.stringify(requirementAnalysis()));
    const requirement = await ingestRequirementAnalysis({ ...fixture, sourcePath: requirementPath });
    const coveragePath = join(fixture.root, "coverage.json");
    await writeFile(coveragePath, JSON.stringify({
      artifactType: "coverage-obligation", schemaVersion: "1.0.0", producerVersion: "1.0.0",
      obligationId: "COV-1", requirementId: "REQ-LOGIN", requirementAnalysisArtifactId: requirement.id,
      role: "member", behavior: "sign in", browser: "chromium", viewport: { width: 1440, height: 900 }, accessibilityMethod: null, risk: "high", required: true, outcome: "account page opens",
    }));
    const coverage = await ingestCoverageObligation({ ...fixture, sourcePath: coveragePath });
    const tampered = JSON.parse(await readFile(coverage.absolutePath, "utf8")) as Record<string, unknown>;
    tampered.requirementId = "REQ-ORPHAN";
    const contents = `${JSON.stringify(tampered, null, 2)}\n`;
    await writeFile(coverage.absolutePath, contents);
    const manifestPath = join(fixture.workspacePath, "artifact-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; sha256: string }[] };
    const record = manifest.artifacts.find((artifact) => artifact.id === coverage.id);
    if (!record) throw new Error("Expected registered coverage");
    record.sha256 = sha256Text(contents);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(RunWorkspace.open(fixture.root, fixture.runId)).rejects.toThrow(/coverage.*orphan|orphan.*requirement/i);
  });
});
