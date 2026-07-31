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
    // Either lane satisfies it, and the diagnostic says so rather than naming only lane 1's artifact.
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "REQUIRED_ARTIFACT_MISSING", artifactType: "test-result or test-result-batch" })]));
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

  it.each([["execute"], ["full"]] as const)("accepts a %s run credited entirely by an observed batch", (profile) => {
    const lane2 = ["run-metadata", "environment-profile", "test-case", "test-result-batch", "qa-execution-report", "evidence"];

    expect(evaluateArtifactProfile(profile, lane2).valid).toBe(true);
    expect(evaluatePublicTerminalProfile(profile, [...lane2, "requirement-analysis", "test-plan", "coverage-obligation", "release-gate"]).valid).toBe(true);
  });

  it("still requires a lane-1 attempt in retest mode, which its own reproduction guarantees", () => {
    const lane2 = ["run-metadata", "environment-profile", "test-case", "test-result-batch", "retest-result", "regression-selection"];

    expect(evaluateArtifactProfile("retest", lane2).diagnostics).toEqual([expect.objectContaining({ artifactType: "test-result" })]);
  });

  it("accepts a regression run whose whole selection was covered by an observed batch", () => {
    // Phase 8b: one selection filters BOTH lanes, so a regression run drives only what lane 2 did not
    // observe and legitimately drives nothing when lane 2 observed all of it. Union coverage of the
    // selection is asserted by the checkpoint chain (src/core/inspect-workspace-state.ts), not here.
    const lane2 = ["run-metadata", "environment-profile", "test-case", "test-result-batch", "regression-selection"];

    expect(evaluateArtifactProfile("regression", lane2).valid).toBe(true);
    expect(evaluateArtifactProfile("regression", ["run-metadata", "environment-profile", "test-case", "regression-selection"]).diagnostics)
      .toEqual([expect.objectContaining({ artifactType: "test-result or test-result-batch" })]);
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
