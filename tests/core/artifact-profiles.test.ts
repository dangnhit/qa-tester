import { describe, expect, it } from "vitest";

import { evaluateArtifactProfile } from "../../src/core/artifact-profiles.js";

describe("artifact profiles", () => {
  it("requires artifacts specific to execute mode", () => {
    const result = evaluateArtifactProfile("execute", ["run-metadata", "environment-profile"]);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "REQUIRED_ARTIFACT_MISSING", artifactType: "test-result" })]));
  });

  it("accepts an evidence gap as a structural substitute for required evidence", () => {
    const result = evaluateArtifactProfile("full", ["run-metadata", "environment-profile", "test-case", "test-result", "qa-execution-report", "evidence-gap"]);
    expect(result.valid).toBe(true);
  });

  it("does not treat unregistered missing files as an evidence gap", () => {
    const result = evaluateArtifactProfile("full", ["run-metadata", "environment-profile", "test-case", "test-result", "qa-execution-report"]);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("REQUIRED_ARTIFACT_MISSING");
  });
});
