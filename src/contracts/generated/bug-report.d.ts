/* This file is generated from shared/schemas. Do not edit manually. */

export interface BugReport {
  artifactType: "bug-report";
  schemaVersion: "1.0.0";
  producerVersion: string;
  bugId: string;
  runId: string;
  attemptId: string;
  triageStatus: "NEEDS_TRIAGE" | "TRIAGED";
  severity?: "Blocker" | "Critical" | "Major" | "Minor" | "Trivial";
  expected: string;
  actual: string;
  /**
   * @minItems 1
   */
  evidenceIds: [string, ...string[]];
}
