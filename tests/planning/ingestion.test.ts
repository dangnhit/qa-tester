import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RunWorkspace } from "../../src/core/run-workspace.js";
import { ingestRequirementAnalysis } from "../../src/operations/ingest-requirement-analysis.js";
import { ingestTestCases } from "../../src/operations/ingest-testcases.js";

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

function requirementAnalysis() {
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
    }],
  };
}

function testPlan(requirementId = "REQ-LOGIN", authority = "AUTHORITATIVE") {
  return {
    artifactType: "test-plan",
    schemaVersion: "1.0.0",
    producerVersion: "1.0.0",
    testPlanId: "PLAN-LOGIN",
    testCases: [{
      testCaseId: "TC-LOGIN",
      title: "Signs in",
      expectedResults: [{ id: "ER-LOGIN", requirementId, authority, text: "The account page opens." }],
      steps: [{ id: "open", action: "navigate", sideEffect: "none" }],
      dslValid: true,
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
    await writeFile(requirementPath, JSON.stringify(requirementAnalysis()));
    await writeFile(planPath, JSON.stringify(testPlan("REQ-LOGIN", "INFERRED")));
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
    await writeFile(planPath, JSON.stringify(testPlan()));
    await ingestRequirementAnalysis({ ...fixture, sourcePath: requirementPath });

    await expect(ingestTestCases({
      ...fixture,
      sourcePath: planPath,
      policy: { mode: "auto-approve-safe" },
    })).rejects.toThrow(/unsafe auto-approval.*production-target/i);
  });
});
