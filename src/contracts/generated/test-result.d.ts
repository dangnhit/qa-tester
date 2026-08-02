/* This file is generated from shared/schemas. Do not edit manually. */

export interface TestResult {
  artifactType: "test-result";
  schemaVersion: "3.0.0";
  producerVersion: string;
  attemptId: string;
  runId: string;
  testCaseId: string;
  testCaseRevisionId: string;
  testCaseInstanceId: string;
  status: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
  failureClassification: "PRODUCT_DEFECT" | "TEST_DEFECT" | "ENVIRONMENT_DEFECT" | "UNDETERMINED" | "NONE";
  /**
   * The browser engine the QA Runtime OBSERVED while driving this attempt, read from the live browser handle. A Browser Matrix member is credited from this value and never from the engine a test case declared (CONTEXT.md:442). Deliberately a free non-empty string rather than an enum: Playwright types BrowserType.name() as string, coverage-obligation.browser is a free string too, and lane 2 reports engines from an external runner this repo does not enumerate. An unrecognized engine matches no obligation, which is already fail-closed; rejecting an honest observation is not.
   */
  observedEngine: string;
  /**
   * @minItems 1
   */
  steps: [
    {
      stepId: string;
      status: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
      durationMs: number;
      failureOrigin?: "action" | "assertion";
      expectedResultId?: string;
    },
    ...{
      stepId: string;
      status: "PASSED" | "FAILED" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN";
      durationMs: number;
      failureOrigin?: "action" | "assertion";
      expectedResultId?: string;
    }[]
  ];
  startedAt: string;
  finishedAt: string;
}
