/* This file is generated from shared/schemas. Do not edit manually. */

export type ProductBug = {
  [k: string]: unknown | undefined;
} & {
  artifactType: "bug-report";
  schemaVersion: "1.0.0";
  producerVersion: string;
  bugId: string;
  runId: string;
  attemptId: string;
  triageStatus: "NEEDS_TRIAGE" | "TRIAGED";
  severity?: "Blocker" | "Critical" | "Major" | "Minor" | "Trivial";
  priorityRecommendation?: "P0" | "P1" | "P2" | "P3";
  testPriority: "critical" | "high" | "medium" | "low";
  expected: string;
  actual: string;
  environment: Environment;
  reproduction: Reproduction;
  /**
   * @minItems 1
   */
  evidenceIds: [string, ...string[]];
  /**
   * @minItems 1
   */
  affectedAreas: [string, ...string[]];
  openQuestions: string[];
  provenance: {
    /**
     * @minItems 1
     */
    sourceAttemptIds: [string, ...string[]];
    evidenceArtifactIds: string[];
  };
  fingerprint: string;
  revision?: number;
  supersedesArtifactId?: string;
  possibleDuplicateSources?: {
    runId: string;
    artifactId: string;
    bugId: string;
    fingerprint: string;
    sha256: string;
  }[];
  open: boolean;
};

export interface Environment {
  environmentProfileId: string;
  name: string;
  classification: "local" | "test" | "staging" | "production";
  baseUrl: string;
}
export interface Reproduction {
  /**
   * @minItems 1
   */
  attemptIds: [string, ...string[]];
  attempted: number;
  total: number;
  rate: string;
  outcome: "REPRODUCED" | "NOT_REPRODUCED" | "INTERMITTENT" | "RERUN_OMITTED_UNSAFE";
  unsafeRerunReason?: string;
}
