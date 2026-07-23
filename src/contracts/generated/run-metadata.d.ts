/* This file is generated from shared/schemas. Do not edit manually. */

type QARunMode = "plan" | "execute" | "full" | "exploratory" | "retest" | "regression" | "cleanup";
type ActiveRunStatus = "CREATED" | "RUNNING" | "FINALIZING";
type TerminalRunStatus = "COMPLETED" | "COMPLETED_WITH_FAILURES" | "BLOCKED" | "ABORTED";

type QARunMetadataBase<M extends QARunMode> = {
  artifactType: "run-metadata";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  createdAt: string;
  mode: M;
  environmentProfileId: string;
  linkedRunId?: string;
};

type ActiveQARunMetadata<M extends QARunMode> = QARunMetadataBase<M> & {
  status: ActiveRunStatus;
  finalizedProfile?: never;
};

type TerminalQARunMetadata<M extends QARunMode> = QARunMetadataBase<M> & {
  status: TerminalRunStatus;
  finalizedProfile: {
    name: M;
    version: "1.0.0";
  };
};

export type QARunMetadata = {
  [M in QARunMode]: ActiveQARunMetadata<M> | TerminalQARunMetadata<M>;
}[QARunMode];
