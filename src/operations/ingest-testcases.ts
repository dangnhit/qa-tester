import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { validateArtifact } from "../contracts/validator.js";
import { QaSkillsError } from "../core/errors.js";
import { RunWorkspace, type ArtifactRecord } from "../core/run-workspace.js";
import { evaluateApproval, type ApprovalEnvironment, type ApprovalPolicy } from "../planning/approval.js";
import type { RequirementAuthority } from "../planning/authority.js";
import { readAgentDraft, type RegisteredPlanningArtifact } from "./ingest-requirement-analysis.js";

type ExpectedResult = { requirementId: string; authority: RequirementAuthority };
type PlanCandidate = {
  testCases: Array<{
    expectedResults: ExpectedResult[];
    dslValid: boolean;
    openQuestions: string[];
    steps: Array<{ sideEffect: "none" | "reversible" | "external" | "destructive"; cleanup?: { declared: boolean } }>;
  }>;
};
type RequirementAnalysis = { statements: Array<{ requirementId: string }> };
type EnvironmentProfile = ApprovalEnvironment;
type Manifest = { artifacts: ArtifactRecord[] };

export type IngestTestCasesOptions = {
  root: string;
  runId: string;
  sourcePath: string;
  relationships?: string[];
  policy?: ApprovalPolicy;
  environment?: ApprovalEnvironment;
};

function isPlanCandidate(value: unknown): value is PlanCandidate {
  return typeof value === "object" && value !== null && Array.isArray((value as Record<string, unknown>).testCases);
}

async function readRegisteredRequirements(workspace: RunWorkspace): Promise<{
  ids: Set<string>;
  artifactIds: string[];
  environment: EnvironmentProfile;
}> {
  const manifest = JSON.parse(await readFile(join(workspace.path, "artifact-manifest.json"), "utf8")) as Manifest;
  const records = manifest.artifacts.filter((artifact) => artifact.type === "requirement-analysis");
  const analyses = await Promise.all(records.map(async (record) => {
    const value = JSON.parse(await readFile(join(workspace.path, record.relativePath), "utf8")) as unknown;
    if (!validateArtifact("requirement-analysis", value).valid) {
      throw new QaSkillsError("Registered requirement analysis is invalid", "ARTIFACT_BINDING");
    }
    return value as RequirementAnalysis;
  }));
  const environmentRecord = manifest.artifacts.find((artifact) => artifact.type === "environment-profile");
  if (!environmentRecord) throw new QaSkillsError("Workspace has no registered environment profile", "ARTIFACT_BINDING");
  const environmentValue = JSON.parse(await readFile(join(workspace.path, environmentRecord.relativePath), "utf8")) as unknown;
  if (!validateArtifact("environment-profile", environmentValue).valid) {
    throw new QaSkillsError("Registered environment profile is invalid", "ARTIFACT_BINDING");
  }
  return {
    ids: new Set(analyses.flatMap((analysis) => analysis.statements.map((statement) => statement.requirementId))),
    artifactIds: records.map((record) => record.id),
    environment: { classification: (environmentValue as EnvironmentProfile).classification },
  };
}

export async function ingestTestCases(options: IngestTestCasesOptions): Promise<RegisteredPlanningArtifact> {
  const draft = await readAgentDraft(options.sourcePath);
  if (!validateArtifact("test-plan", draft).valid || !isPlanCandidate(draft)) {
    throw new QaSkillsError("Test Case Agent Draft does not satisfy the test plan contract", "INVALID_ARTIFACT");
  }
  const workspace = await RunWorkspace.open(options.root, options.runId);
  try {
    const requirements = await readRegisteredRequirements(workspace);
    for (const testCase of draft.testCases) {
      for (const expectedResult of testCase.expectedResults) {
        if (!requirements.ids.has(expectedResult.requirementId)) {
          throw new QaSkillsError("Orphan expected result does not reference a registered requirement", "ARTIFACT_BINDING");
        }
      }
      if (options.policy?.mode === "auto-approve-safe") {
        if (options.environment && options.environment.classification !== requirements.environment.classification) {
          throw new QaSkillsError("Approval environment does not match the registered environment profile", "ARTIFACT_BINDING");
        }
        const decision = evaluateApproval(
          testCase,
          options.policy,
          requirements.environment,
        );
        if (!decision.approved) {
          throw new QaSkillsError(`Unsafe auto-approval: ${decision.reasons.join(", ")}`, "UNSAFE_OPERATION");
        }
      }
    }
    return await workspace.registerArtifact({
      type: "test-plan",
      sourcePath: options.sourcePath,
      relationships: [...new Set([...(options.relationships ?? []), ...requirements.artifactIds])],
      provenance: "agent-draft",
    });
  } finally {
    await workspace.close();
  }
}
