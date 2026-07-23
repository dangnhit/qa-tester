import { createEntityId } from "../core/ids.js";
import { QaSkillsError } from "../core/errors.js";
import { RunWorkspace, type ArtifactRecord } from "../core/run-workspace.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function recordHumanApproval(input: { root: string; runId: string; planArtifactId: string; approvedBy: string }): Promise<ArtifactRecord> {
  if (input.approvedBy.trim() === "") throw new QaSkillsError("Human approver identity is required", "INVALID_ARTIFACT");
  const workspace = await RunWorkspace.open(input.root, input.runId);
  try {
    const artifacts = await workspace.readRegisteredArtifacts();
    const plan = artifacts.find((artifact) => artifact.record.id === input.planArtifactId && artifact.record.type === "test-plan");
    if (!plan || !record(plan.value.approvalPolicy) || plan.value.approvalPolicy.mode !== "human-review") {
      throw new QaSkillsError("Human approval requires one registered human-review test plan", "ARTIFACT_BINDING");
    }
    if (!record(plan.value.approvalDecision) || plan.value.approvalDecision.approved !== false || plan.value.approvalDecision.mode !== "HUMAN_REVIEW") {
      throw new QaSkillsError("Human approval can only resolve a pending derived human-review decision", "ARTIFACT_BINDING");
    }
    return workspace.registerArtifactValue({
      type: "approval-decision",
      relationships: [plan.record.id],
      provenance: `human-approval:${input.approvedBy.trim()}`,
      value: {
        artifactType: "approval-decision",
        schemaVersion: "1.0.0",
        producerVersion: "0.1.0",
        approvalId: createEntityId(),
        runId: workspace.runId,
        planArtifactId: plan.record.id,
        planSha256: plan.record.sha256,
        decision: "APPROVED",
        approvedBy: input.approvedBy.trim(),
        approvedAt: new Date().toISOString(),
      },
    });
  } finally {
    await workspace.close();
  }
}
