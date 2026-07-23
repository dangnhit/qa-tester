import type { ErrorObject } from "ajv";

import { artifactValidators } from "./catalog.js";
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
