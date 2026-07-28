import { QaSkillsError } from "./errors.js";

export const artifactProfileNames = ["plan", "execute", "full", "exploratory", "retest", "regression", "cleanup"] as const;
export type ArtifactProfileName = (typeof artifactProfileNames)[number];
export const artifactProfileVersion = "1.0.0" as const;

export type ProfileDiagnostic = { code: "REQUIRED_ARTIFACT_MISSING"; artifactType: string; message: string };
export type ArtifactProfileEvaluation = { valid: boolean; diagnostics: ProfileDiagnostic[] };

/**
 * The two artifacts that record an executed test case, either of which satisfies the "this run
 * executed something" requirement. Lane 1 writes one `test-result` per **Test Attempt**; lane 2 writes
 * one `test-result-batch` per **Runtime-Observed Execution**, carrying one entry per observed case
 * (ADR-0010). Both are gated by the same `creditsCoverage` provenance predicate and both are read by
 * both coverage readers, so a profile that named only the first would make a run credited ENTIRELY by
 * an observed batch structurally invalid — reporting an unmet obligation where the truth is that the
 * run was executed in the other lane.
 *
 * Deliberately NOT applied to `retest` or `regression`. Those profiles require a `test-result` because
 * their own artifacts bind to `attemptId`s (`retest-result.reproductionScenarios[].sourceAttemptArtifactId`,
 * and `selectRegressionCases`' attempt-keyed selection), and a batch entry has no attempt to bind to.
 * Extending either lane-2-ward is Phase 8's retest/regression work, not a line in this table.
 */
const executionRecord = ["test-result", "test-result-batch"] as const;

const requirements: Readonly<Record<ArtifactProfileName, readonly (readonly string[])[]>> = {
  plan: [["run-metadata"], ["environment-profile"]],
  execute: [["run-metadata"], ["environment-profile"], ["test-case"], executionRecord],
  full: [["run-metadata"], ["environment-profile"], ["test-case"], executionRecord, ["qa-execution-report"], ["evidence", "evidence-gap"]],
  exploratory: [["run-metadata"], ["environment-profile"], ["exploration-charter"]],
  retest: [["run-metadata"], ["environment-profile"], ["test-result"], ["retest-result"]],
  regression: [["run-metadata"], ["environment-profile"], ["regression-selection"], ["test-case"], ["test-result"]],
  cleanup: [["run-metadata"], ["environment-profile"], ["cleanup-run"]],
};

const publicTerminalRequirements: Readonly<Partial<Record<ArtifactProfileName, readonly (readonly string[])[]>>> = {
  plan: [["requirement-analysis"], ["test-plan"], ["test-case"], ["coverage-obligation"]],
  execute: [["requirement-analysis"], ["test-plan"], ["test-case"], ["coverage-obligation"], executionRecord, ["evidence", "evidence-gap"]],
  full: [["requirement-analysis"], ["test-plan"], ["test-case"], ["coverage-obligation"], executionRecord, ["evidence", "evidence-gap"], ["release-gate"], ["qa-execution-report"]],
};

export function assertArtifactProfileName(profile: string): asserts profile is ArtifactProfileName {
  if (!(artifactProfileNames as readonly string[]).includes(profile)) {
    throw new QaSkillsError(`Unknown unaudited artifact profile: ${profile}`, "INVALID_PROFILE");
  }
}

export function evaluateArtifactProfile(profile: ArtifactProfileName, artifactTypes: readonly string[]): ArtifactProfileEvaluation {
  assertArtifactProfileName(profile);
  const present = new Set(artifactTypes);
  const diagnostics = requirements[profile].flatMap((alternatives) => {
    if (alternatives.some((type) => present.has(type))) return [];
    return [{
      code: "REQUIRED_ARTIFACT_MISSING" as const,
      artifactType: alternatives.join(" or "),
      message: `Profile ${profile} requires ${alternatives.join(" or ")}`,
    }];
  });
  return { valid: diagnostics.length === 0, diagnostics };
}

/** Additional completeness obligations for terminal public workflows; lifecycle-only workspaces retain the structural profile above. */
export function evaluatePublicTerminalProfile(profile: ArtifactProfileName, artifactTypes: readonly string[]): ArtifactProfileEvaluation {
  const present = new Set(artifactTypes);
  const diagnostics = (publicTerminalRequirements[profile] ?? []).flatMap((alternatives) => alternatives.some((type) => present.has(type)) ? [] : [{
    code: "REQUIRED_ARTIFACT_MISSING" as const,
    artifactType: alternatives.join(" or "),
    message: `Terminal public profile ${profile} requires ${alternatives.join(" or ")}`,
  }]);
  return { valid: diagnostics.length === 0, diagnostics };
}
