/* This file is generated from shared/schemas. Do not edit manually. */

export type QARunMetadata = {
  [k: string]: unknown | undefined;
} & {
  artifactType: "run-metadata";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  status: "CREATED" | "RUNNING" | "FINALIZING" | "COMPLETED" | "COMPLETED_WITH_FAILURES" | "BLOCKED" | "ABORTED";
  createdAt: string;
  mode: "plan" | "execute" | "full" | "exploratory" | "retest" | "regression" | "cleanup";
  environmentProfileId: string;
  finalizedProfile?: {
    name: "plan" | "execute" | "full" | "exploratory" | "retest" | "regression" | "cleanup";
    version: "1.0.0";
  };
  linkedRunId?: string;
};
