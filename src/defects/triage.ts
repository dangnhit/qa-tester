export type DefectSeverity = "Blocker" | "Critical" | "Major" | "Minor" | "Trivial";
export type PriorityRecommendation = "P0" | "P1" | "P2" | "P3";
export type TestPriority = "critical" | "high" | "medium" | "low";
export type TriageInput = Readonly<{ status: "NEEDS_TRIAGE" | "TRIAGED"; severity?: DefectSeverity; priorityRecommendation?: PriorityRecommendation; testPriority?: TestPriority; openQuestions: readonly string[] }>;
export type BugTriage = Readonly<{ triageStatus: "NEEDS_TRIAGE"; openQuestions: readonly string[] } | { triageStatus: "TRIAGED"; severity: DefectSeverity; priorityRecommendation: PriorityRecommendation; testPriority: TestPriority; openQuestions: readonly string[] }>;

export function createTriage(input: TriageInput): BugTriage {
  if (input.status === "NEEDS_TRIAGE") {
    if (input.severity !== undefined || input.priorityRecommendation !== undefined) throw new Error("NEEDS_TRIAGE must not have severity or priority recommendation");
    return { triageStatus: "NEEDS_TRIAGE", openQuestions: [...input.openQuestions] };
  }
  if (!input.severity || !input.priorityRecommendation || !input.testPriority) throw new Error("TRIAGED requires severity, priority recommendation, and test priority");
  return { triageStatus: "TRIAGED", severity: input.severity, priorityRecommendation: input.priorityRecommendation, testPriority: input.testPriority, openQuestions: [...input.openQuestions] };
}
