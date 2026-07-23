import { QaSkillsError } from "./errors.js";

export const artifactProfileNames = ["plan", "execute", "full", "exploratory", "retest", "regression", "cleanup"] as const;
export type ArtifactProfileName = (typeof artifactProfileNames)[number];
export const artifactProfileVersion = "1.0.0" as const;

export type ProfileDiagnostic = { code: "REQUIRED_ARTIFACT_MISSING"; artifactType: string; message: string };
export type ArtifactProfileEvaluation = { valid: boolean; diagnostics: ProfileDiagnostic[] };

const requirements: Readonly<Record<ArtifactProfileName, readonly (readonly string[])[]>> = {
  plan: [["run-metadata"], ["environment-profile"]],
  execute: [["run-metadata"], ["environment-profile"], ["test-case"], ["test-result"]],
  full: [["run-metadata"], ["environment-profile"], ["test-case"], ["test-result"], ["qa-execution-report"], ["evidence", "evidence-gap"]],
  exploratory: [["run-metadata"], ["environment-profile"], ["exploration-charter"], ["evidence", "evidence-gap"]],
  retest: [["run-metadata"], ["environment-profile"], ["test-result"], ["retest-result"]],
  regression: [["run-metadata"], ["environment-profile"], ["regression-selection"], ["test-case"], ["test-result"]],
  cleanup: [["run-metadata"], ["environment-profile"], ["cleanup-run"]],
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
