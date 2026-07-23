/* This file is generated from shared/schemas. Do not edit manually. */

export interface RetestResult {
  artifactType: "retest-result";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  sourceRunId: string;
  sourceBugArtifactId: string;
  sourceBugArtifactSha256: string;
  bugId: string;
  /**
   * @minItems 1
   */
  reproductionAttemptIds: [string, ...string[]];
  /**
   * @minItems 1
   */
  reproductionScenarios: [
    {
      scenarioId: string;
      sourceAttemptArtifactId: string;
      sourceTestCaseArtifactId: string;
      attemptId: string;
      status: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
    },
    ...{
      scenarioId: string;
      sourceAttemptArtifactId: string;
      sourceTestCaseArtifactId: string;
      attemptId: string;
      status: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
    }[]
  ];
  regressionAttemptIds: string[];
  verdict: "FIXED" | "NOT_FIXED" | "PARTIALLY_FIXED" | "CANNOT_VERIFY" | "INTERMITTENT";
  regressionOutcome: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
}
