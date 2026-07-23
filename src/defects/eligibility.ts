export type DefectAttempt = Readonly<{
  attemptId: string;
  runId: string;
  testCaseId: string;
  status: string;
  failureClassification: string;
}>;

export type BugCandidate = Readonly<{
  attemptId: string;
  runId: string;
  testCaseId: string;
}>;

/** The sole automatic bug-entry rule: a failed product diagnosis. */
export function createBugCandidate(attempt: DefectAttempt): BugCandidate | null {
  if (attempt.status !== "FAILED" || attempt.failureClassification !== "PRODUCT_DEFECT") return null;
  return { attemptId: attempt.attemptId, runId: attempt.runId, testCaseId: attempt.testCaseId };
}
