import type { DefectAttempt } from "./eligibility.js";

export type IncidentKind = "TEST_INCIDENT" | "ENVIRONMENT_INCIDENT" | "INVESTIGATION_FINDING";
export type IncidentCandidate = Readonly<{ kind: IncidentKind; attemptId: string; runId: string; testCaseId: string }>;

/** Preserves non-product diagnoses without claiming an unobserved product cause. */
export function createIncidentFromAttempt(attempt: DefectAttempt): IncidentCandidate | null {
  const kinds: Readonly<Record<string, IncidentKind>> = {
    TEST_DEFECT: "TEST_INCIDENT",
    ENVIRONMENT_DEFECT: "ENVIRONMENT_INCIDENT",
    UNDETERMINED: "INVESTIGATION_FINDING",
  };
  const kind = kinds[attempt.failureClassification];
  return kind === undefined ? null : { kind, attemptId: attempt.attemptId, runId: attempt.runId, testCaseId: attempt.testCaseId };
}
