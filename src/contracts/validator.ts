import type { ErrorObject } from "ajv";

import { annotationValidator, artifactValidators, browserTestDslValidator, planningActionValidator, qaConfigValidator } from "./catalog.js";
import type { ArtifactType, NormalizedValidationError, ValidationResult } from "./types.js";

function normalizeErrors(errors: ErrorObject[] | null | undefined): NormalizedValidationError[] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "validation failed",
  }));
}

/** The single shared renderer for normalized Ajv errors; every ingestion site interpolates this. */
export function formatValidationErrors(errors: readonly NormalizedValidationError[]): string {
  if (errors.length === 0) return "no diagnostics available";
  return errors.map((error) => `${error.instancePath || "/"} ${error.message} (${error.keyword})`).join("; ");
}

export function validateArtifact(type: ArtifactType, value: unknown): ValidationResult {
  const validator = artifactValidators[type];
  const valid = validator(value);

  return {
    valid: Boolean(valid),
    errors: valid ? [] : normalizeErrors(validator.errors),
  };
}

export function validatePlanningAction(value: unknown): ValidationResult {
  const valid = planningActionValidator(value);
  return { valid: Boolean(valid), errors: valid ? [] : normalizeErrors(planningActionValidator.errors) };
}

export function validateBrowserTestDsl(value: unknown): ValidationResult {
  const valid = browserTestDslValidator(value);
  return { valid: Boolean(valid), errors: valid ? [] : normalizeErrors(browserTestDslValidator.errors) };
}

export function validateAnnotation(value: unknown): ValidationResult {
  const valid = annotationValidator(value);
  return { valid: Boolean(valid), errors: valid ? [] : normalizeErrors(annotationValidator.errors) };
}

export function validateQaConfig(value: unknown): ValidationResult {
  const valid = qaConfigValidator(value);
  return { valid: Boolean(valid), errors: valid ? [] : normalizeErrors(qaConfigValidator.errors) };
}
