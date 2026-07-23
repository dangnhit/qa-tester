/* This file is generated from shared/schemas. Do not edit manually. */

export interface RegressionSelection {
  artifactType: "regression-selection";
  schemaVersion: "1.0.0";
  producerVersion: string;
  selectionId: string;
  runId: string;
  changeScopeArtifactId: string;
  changeScopeSha256: string;
  decisionChecksum: string;
  selected: Decision[];
  excluded: Decision[];
  unmappedChangeRisks: {
    changeId: string;
    rationale: string;
    confidence: number;
  }[];
  complete: boolean;
}
export interface Decision {
  testCaseId: string;
  revisionId: string;
  source: "requirement-mapping" | "code-surface-mapping" | "declared-dependency" | "git-diff-heuristic" | "user-scope";
  rationale: string;
  confidence: number;
}
