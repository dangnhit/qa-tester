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
 * Applied to `regression` since Phase 8b, which is the "Phase 8 work" the earlier deferral named. A
 * regression selection is now ONE filter over both lanes: `execute-browser-test` drives only the selected
 * cases lane 2 did not observe (src/operations/run-workflow.ts), so a selection an observed batch covered
 * ENTIRELY legitimately drives nothing, and a profile naming only lane 1's artifact would call that run
 * structurally invalid for executing everything it was asked to. It does not weaken the obligation: the
 * checkpoint comparison in src/core/inspect-workspace-state.ts asks union coverage of both lanes, so a
 * selected case covered by NEITHER still invalidates the run, and a run with nothing selected and nothing
 * observed is still refused before any of this by `execute-browser-test` itself.
 *
 * Still deliberately NOT applied to `retest`. `retest-result` binds every reproduction scenario to a
 * `sourceAttemptArtifactId` and an `attemptId`, and a batch entry has neither — it is keyed by `entryId`
 * precisely because no attempt was driven. A retest also always drives its reproduction: the source bug
 * must name at least one source attempt and `reproduce-bug` refuses any result set that does not
 * reproduce every one of them, so a lane-1 attempt is not merely required here but guaranteed.
 */
const executionRecord = ["test-result", "test-result-batch"] as const;

const requirements: Readonly<Record<ArtifactProfileName, readonly (readonly string[])[]>> = {
  plan: [["run-metadata"], ["environment-profile"]],
  execute: [["run-metadata"], ["environment-profile"], ["test-case"], executionRecord],
  full: [["run-metadata"], ["environment-profile"], ["test-case"], executionRecord, ["qa-execution-report"], ["evidence", "evidence-gap"]],
  exploratory: [["run-metadata"], ["environment-profile"], ["exploration-charter"]],
  retest: [["run-metadata"], ["environment-profile"], ["test-result"], ["retest-result"]],
  regression: [["run-metadata"], ["environment-profile"], ["regression-selection"], ["test-case"], executionRecord],
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
