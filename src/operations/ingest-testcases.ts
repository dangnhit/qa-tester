import { validateArtifact } from "../contracts/validator.js";
import { QaSkillsError } from "../core/errors.js";
import { RunWorkspace } from "../core/run-workspace.js";
import type { ApprovalEnvironment, ApprovalPolicy } from "../planning/approval.js";
import { readAgentDraft, type RegisteredPlanningArtifact } from "./ingest-requirement-analysis.js";

type TestPlanDraft = { approvalPolicy: ApprovalPolicy };

export type IngestTestCasesOptions = {
  root: string;
  runId: string;
  sourcePath: string;
  relationships?: string[];
  policy?: ApprovalPolicy;
  environment?: ApprovalEnvironment;
};

function isTestPlanDraft(value: unknown): value is TestPlanDraft {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).approvalPolicy === "object";
}

export async function ingestTestCases(options: IngestTestCasesOptions): Promise<RegisteredPlanningArtifact> {
  const draft = await readAgentDraft(options.sourcePath);
  if (!validateArtifact("test-plan", draft).valid || !isTestPlanDraft(draft)) {
    throw new QaSkillsError("Test Case Agent Draft does not satisfy the test plan contract", "INVALID_ARTIFACT");
  }
  if (options.policy && options.policy.mode !== draft.approvalPolicy.mode) {
    throw new QaSkillsError("Approval policy option does not match the test plan", "ARTIFACT_BINDING");
  }
  const workspace = await RunWorkspace.open(options.root, options.runId);
  try {
    return await workspace.registerArtifactValue({
      type: "test-plan",
      value: { ...draft, approvalDecision: { approved: draft.approvalPolicy.mode === "auto-approve-safe" } },
      relationships: options.relationships ?? [],
      provenance: "agent-draft",
    });
  } finally {
    await workspace.close();
  }
}
