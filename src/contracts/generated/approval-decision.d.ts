/* This file is generated from shared/schemas. Do not edit manually. */

export interface HumanApprovalDecision {
  artifactType: "approval-decision";
  schemaVersion: "1.0.0";
  producerVersion: string;
  approvalId: string;
  runId: string;
  planArtifactId: string;
  planSha256: string;
  decision: "APPROVED";
  approvedBy: string;
  approvedAt: string;
}
