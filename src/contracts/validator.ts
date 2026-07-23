import type { ErrorObject } from "ajv";

import { artifactValidators, browserTestDslValidator, planningActionValidator } from "./catalog.js";
import type { ArtifactType, NormalizedValidationError, ValidationResult } from "./types.js";

function normalizeErrors(errors: ErrorObject[] | null | undefined): NormalizedValidationError[] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "validation failed",
  }));
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
