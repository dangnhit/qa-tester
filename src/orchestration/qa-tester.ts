import { runWorkflow, type WorkflowInput, type WorkflowResult } from "../operations/run-workflow.js";

/** Thin Skill Adapter boundary: it selects a runtime workflow and never shells one skill into another. */
export function qaTester(input: WorkflowInput): Promise<WorkflowResult> {
  return runWorkflow(input);
}
