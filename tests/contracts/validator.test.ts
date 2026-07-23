import { describe, expect, it } from "vitest";

import { validateArtifact } from "../../src/contracts/validator.js";

const validRun = {
  artifactType: "run-metadata",
  schemaVersion: "1.0.0",
  producerVersion: "1.0.0",
  runId: "20260723T123456Z-a1b2c3",
  status: "CREATED",
  createdAt: "2026-07-23T12:34:56.000Z",
  mode: "full",
  environmentProfileId: "env-staging",
};

describe("validateArtifact", () => {
  it("accepts a valid run metadata envelope", () => {
    expect(validateArtifact("run-metadata", validRun).valid).toBe(true);
  });

  it("rejects an invalid run status without mutating the supplied artifact", () => {
    const invalidRun = { ...validRun, status: "PASS" };
    const beforeValidation = structuredClone(invalidRun);

    const result = validateArtifact("run-metadata", invalidRun);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instancePath: "/status", keyword: "enum" }),
      ]),
    );
    expect(invalidRun).toEqual(beforeValidation);
  });
});
