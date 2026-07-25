/* This file is generated from shared/schemas. Do not edit manually. */

export interface QAExecutionReport {
  artifactType: "qa-execution-report";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  generatedAt: string;
  build: {
    identifier: string;
  };
  summary: string;
  coverageMethods: string[];
  incidents: {
    [k: string]: unknown | undefined;
  }[];
  bugs: {
    [k: string]: unknown | undefined;
  }[];
  telemetryFindings: {
    [k: string]: unknown | undefined;
  }[];
  evidenceGaps: {
    [k: string]: unknown | undefined;
  }[];
  cleanupLeaks: {
    [k: string]: unknown | undefined;
  }[];
  criticalFindings: string[];
  remainingRisks: string[];
  excludedNotRun: string[];
  protectedEnvironment?: boolean;
  releaseGate: {
    sourceArtifacts: {
      [k: string]: unknown | undefined;
    }[];
    recommendation: "READY" | "READY_WITH_RISKS" | "NOT_READY";
    protectedEnvironment?: boolean;
    ruleInputs: {
      [k: string]: unknown | undefined;
    };
    verdicts: {
      [k: string]: unknown | undefined;
    }[];
  };
  releaseRecommendation: "READY" | "READY_WITH_RISKS" | "NOT_READY";
}
