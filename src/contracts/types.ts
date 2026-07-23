export const artifactTypes = [
  "run-metadata",
  "artifact-manifest",
  "environment-profile",
  "test-case",
  "test-step-result",
  "test-result",
  "evidence",
  "evidence-gap",
  "bug-report",
  "test-data-manifest",
  "qa-execution-report",
  "requirement-analysis",
  "coverage-obligation",
  "test-plan",
] as const;

export type ArtifactType = (typeof artifactTypes)[number];

export const runStatuses = [
  "CREATED",
  "RUNNING",
  "FINALIZING",
  "COMPLETED",
  "COMPLETED_WITH_FAILURES",
  "BLOCKED",
  "ABORTED",
] as const;

export type RunStatus = (typeof runStatuses)[number];

export const executionStatuses = ["PASSED", "FAILED", "BLOCKED", "INCONCLUSIVE", "NOT_RUN"] as const;

export type ExecutionStatus = (typeof executionStatuses)[number];

export const failureClassifications = [
  "PRODUCT_DEFECT",
  "TEST_DEFECT",
  "ENVIRONMENT_DEFECT",
  "UNDETERMINED",
  "NONE",
] as const;

export type FailureClassification = (typeof failureClassifications)[number];

export const sideEffectClasses = ["none", "reversible", "external", "destructive"] as const;

export type SideEffectClass = (typeof sideEffectClasses)[number];

export type ArtifactEnvelope<T extends object = object> = {
  artifactType: ArtifactType;
  schemaVersion: "1.0.0";
  producerVersion: string;
} & T;

export interface NormalizedValidationError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: NormalizedValidationError[];
}
