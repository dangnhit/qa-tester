import { createQaTester, type QaRuntimeRegistry, type QaWorkflowInput, type WorkflowResult } from "../operations/run-workflow.js";

export { createQaTester } from "../operations/run-workflow.js";
export type { QaRuntimeRegistry, QaWorkflowInput, WorkflowResult, WorkflowOutput, WorkflowTerminalStatus, WorkflowOperationInputMap, WorkflowOperationOutputMap, CorrelatedWorkflowOutputs, CanonicalPlanBundleRef, RegisteredArtifactRef, PendingHumanInput, PendingHumanInputSubject } from "../operations/run-workflow.js";
export { selectRegressionCases, regressionMappingSources } from "../regression/selector.js";
export type { ChangeScope, RegressionCase } from "../regression/change-scope.js";
export type { RegressionDecision, RegressionSelection, RegressionSource, UnmappedChangeRisk } from "../regression/selector.js";

/** Thin Skill Adapter boundary: it selects a runtime workflow and never shells one skill into another. */
export function qaTester(runtime: QaRuntimeRegistry, input: QaWorkflowInput): Promise<WorkflowResult> {
  return createQaTester(runtime)(input);
}
