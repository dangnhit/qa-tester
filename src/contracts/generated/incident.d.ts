/* This file is generated from shared/schemas. Do not edit manually. */

export interface QAIncidentOrInvestigationFinding {
  artifactType: "incident";
  schemaVersion: "1.0.0";
  producerVersion: string;
  incidentId: string;
  runId: string;
  attemptId: string;
  kind: "TEST_INCIDENT" | "ENVIRONMENT_INCIDENT" | "INVESTIGATION_FINDING";
  summary: string;
  environment: {
    environmentProfileId: string;
    name: string;
    classification: "local" | "test" | "staging" | "production";
    baseUrl: string;
  };
  evidenceIds: string[];
  /**
   * @minItems 1
   */
  affectedAreas: [string, ...string[]];
  openQuestions: string[];
  provenance: {
    sourceAttemptId: string;
  };
}
