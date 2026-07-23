/* This file is generated from shared/schemas. Do not edit manually. */

export type Refs = Ref[];

export interface WorkflowCheckpoint {
  artifactType: "workflow-checkpoint";
  schemaVersion: "1.0.0";
  producerVersion: string;
  checkpointId: string;
  runId: string;
  mode: "plan" | "execute" | "full" | "exploratory" | "retest" | "regression";
  inputChecksum: string;
  stateChecksum: string;
  revision: number;
  supersedesArtifactId?: string;
  completedOperations: (
    | "ingest-requirement-analysis"
    | "ingest-testcases"
    | "ingest-coverage-obligation"
    | "prepare-test-data"
    | "execute-browser-test"
    | "collect-evidence"
    | "generate-bug-report"
    | "generate-qa-report"
    | "register-exploration-charter"
    | "reproduce-bug"
    | "select-regression"
    | "derive-retest-verdict"
  )[];
  operationOutputs: {
    [k: string]:
      | {
          artifactId: string;
          sha256: string;
        }[]
      | undefined;
  };
  bundle?: {
    sourceRunId: string;
    artifacts: {
      artifactId: string;
      sha256: string;
    }[];
  };
  state: {
    importedArtifacts: Refs;
    executionCases: Refs;
    reproductionAttempts: Refs;
    regressionAttempts: Refs;
    exploratoryFindings: Refs;
    selection?: Ref;
    charter?: Ref;
    retestSource?: {
      [k: string]: unknown | undefined;
    };
  };
}
export interface Ref {
  artifactId: string;
  sha256: string;
}
