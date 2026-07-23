import { describe, expect, it } from "vitest";

import * as artifactProfiles from "../../src/core/artifact-profiles.js";
import { evaluateArtifactProfile, evaluatePublicTerminalProfile } from "../../src/core/artifact-profiles.js";

describe("artifact profiles", () => {
  it("publishes a version for the audited profile definitions", () => {
    expect(artifactProfiles).toHaveProperty("artifactProfileVersion", "1.0.0");
  });

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

  it("rejects unknown unaudited profile names", () => {
    expect(() => evaluateArtifactProfile("invented" as never, [])).toThrow(/profile/i);
  });

  it("rejects terminal public plan and full profiles that omit canonical planning facts", () => {
    expect(evaluatePublicTerminalProfile("plan", ["test-case"]).diagnostics.map((item) => item.artifactType)).toEqual(expect.arrayContaining(["requirement-analysis", "test-plan", "coverage-obligation"]));
    expect(evaluatePublicTerminalProfile("full", ["test-result", "evidence", "release-gate", "qa-execution-report"]).valid).toBe(false);
    expect(evaluatePublicTerminalProfile("plan", ["requirement-analysis", "test-plan", "test-case", "coverage-obligation"]).valid).toBe(true);
  });
});
