/* This file is generated from shared/schemas. Do not edit manually. */

export type QAIncidentOrInvestigationFinding = (
  | {
      evidenceIds: unknown;
      [k: string]: unknown | undefined;
    }
  | {
      evidenceGapIds: unknown;
      [k: string]: unknown | undefined;
    }
) & {
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
  /**
   * @minItems 1
   */
  evidenceIds: [string, ...string[]];
  /**
   * @minItems 1
   */
  evidenceGapIds?: [string, ...string[]];
  /**
   * @minItems 1
   */
  affectedAreas: [string, ...string[]];
  openQuestions: string[];
  provenance: {
    sourceAttemptId: string;
  };
};
