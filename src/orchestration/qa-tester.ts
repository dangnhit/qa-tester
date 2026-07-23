import { createQaTester, type QaRuntimeRegistry, type QaWorkflowInput, type WorkflowResult } from "../operations/run-workflow.js";

/** Thin Skill Adapter boundary: it selects a runtime workflow and never shells one skill into another. */
export function qaTester(runtime: QaRuntimeRegistry, input: QaWorkflowInput): Promise<WorkflowResult> {
  return createQaTester(runtime)(input);
}
