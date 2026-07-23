import type { DefectSeverity } from "../defects/triage.js";

export type GateBug = Readonly<{ bugId: string; triageStatus: "NEEDS_TRIAGE" | "TRIAGED"; severity?: DefectSeverity; open: boolean }>;
export type ReleaseGateInput = Readonly<{
  artifactsValid: boolean;
  coverage: Readonly<{ requiredMissing: readonly string[]; optionalGaps: readonly string[]; requiredHighRisk: readonly { obligationId: string; passed: boolean }[] }>;
  bugs: readonly GateBug[];
  sharedBlockers: readonly string[];
}>;
export type RuleVerdict = Readonly<{ rule: string; passed: boolean; reason: string }>;
export type ReleaseGateResult = Readonly<{ recommendation: "READY" | "READY_WITH_RISKS" | "NOT_READY"; ruleInputs: ReleaseGateInput; verdicts: readonly RuleVerdict[] }>;

/** Deterministic policy only: narrative code may describe this result but cannot alter it. */
export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateResult {
  const open = input.bugs.filter((bug) => bug.open);
  const untriaged = open.filter((bug) => bug.triageStatus === "NEEDS_TRIAGE");
  const blockers = open.filter((bug) => bug.triageStatus === "TRIAGED" && (bug.severity === "Blocker" || bug.severity === "Critical"));
  const nonCritical = open.filter((bug) => bug.triageStatus === "TRIAGED" && bug.severity !== "Blocker" && bug.severity !== "Critical");
  const highRiskMisses = input.coverage.requiredHighRisk.filter((obligation) => !obligation.passed);
  const verdicts: RuleVerdict[] = [
    { rule: "VALID_ARTIFACTS", passed: input.artifactsValid, reason: input.artifactsValid ? "All registered artifacts are valid." : "One or more registered artifacts are invalid." },
    { rule: "NO_SHARED_BLOCKERS", passed: input.sharedBlockers.length === 0, reason: input.sharedBlockers.length === 0 ? "No shared blockers are present." : `Shared blockers: ${input.sharedBlockers.join(", ")}.` },
    { rule: "NO_OPEN_BLOCKER_OR_CRITICAL", passed: blockers.length === 0, reason: blockers.length === 0 ? "No open Blocker or Critical product bug." : `Open Blocker/Critical bugs: ${blockers.map((bug) => bug.bugId).join(", ")}.` },
    { rule: "NO_UNTRIAGED_PRODUCT_BUG", passed: untriaged.length === 0, reason: untriaged.length === 0 ? "No open untriaged product bug." : `Open untriaged bugs: ${untriaged.map((bug) => bug.bugId).join(", ")}.` },
    { rule: "REQUIRED_HIGH_RISK_PASSED", passed: highRiskMisses.length === 0, reason: highRiskMisses.length === 0 ? "All required high-risk obligations passed." : `Required high-risk obligations not passing: ${highRiskMisses.map((item) => item.obligationId).join(", ")}.` },
    { rule: "REQUIRED_COVERAGE_COMPLETE", passed: input.coverage.requiredMissing.length === 0, reason: input.coverage.requiredMissing.length === 0 ? "All required coverage obligations are satisfied." : `Required coverage missing: ${input.coverage.requiredMissing.join(", ")}.` },
  ];
  const hardFailure = verdicts.some((verdict) => !verdict.passed);
  if (hardFailure) return { recommendation: "NOT_READY", ruleInputs: input, verdicts };
  const hasRisks = input.coverage.optionalGaps.length > 0 || nonCritical.length > 0;
  const completion: RuleVerdict = {
    rule: "NO_OPEN_PRODUCT_DEFECT_FOR_READY",
    passed: open.length === 0,
    reason: open.length === 0 ? "No open product defect remains." : `Open non-critical product bugs: ${nonCritical.map((bug) => bug.bugId).join(", ")}.`,
  };
  return { recommendation: hasRisks ? "READY_WITH_RISKS" : "READY", ruleInputs: input, verdicts: [...verdicts, completion] };
}
