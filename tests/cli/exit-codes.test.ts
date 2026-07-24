import { describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { workflowExitCode } from "../../src/cli/exit-codes.js";
import type { WorkflowResult } from "../../src/operations/run-workflow.js";

type Case = Pick<WorkflowResult, "outcome" | "validation" | "releaseRecommendation">;

function result(overrides: Partial<Case>): Case {
  return { outcome: "COMPLETED", validation: { valid: true, diagnostics: [] }, ...overrides };
}

describe("workflowExitCode", () => {
  it.each([
    ["ABORTED outcome", result({ outcome: "ABORTED" }), ExitCode.ABORTED_OR_INTERNAL],
    ["BLOCKED outcome", result({ outcome: "BLOCKED" }), ExitCode.BLOCKED],
    ["AWAITING_RUNTIME outcome (nothing executed)", result({ outcome: "AWAITING_RUNTIME" }), ExitCode.BLOCKED],
    ["invalid workspace validation", result({ validation: { valid: false, diagnostics: [{ code: "REQUIRED_ARTIFACT_MISSING", message: "missing" }] } }), ExitCode.UNMET_OBLIGATIONS],
    ["NOT_READY release recommendation", result({ releaseRecommendation: "NOT_READY" }), ExitCode.UNMET_OBLIGATIONS],
    ["COMPLETED_WITH_FAILURES outcome with no gate", result({ outcome: "COMPLETED_WITH_FAILURES" }), ExitCode.UNMET_OBLIGATIONS],
    ["COMPLETED + READY gate", result({ outcome: "COMPLETED", releaseRecommendation: "READY" }), ExitCode.SUCCESS],
    ["COMPLETED + READY_WITH_RISKS gate", result({ outcome: "COMPLETED", releaseRecommendation: "READY_WITH_RISKS" }), ExitCode.SUCCESS],
    ["COMPLETED + no gate at all", result({ outcome: "COMPLETED" }), ExitCode.SUCCESS],
  ] as const)("maps %s to the documented exit code", (_label, input, expected) => {
    expect(workflowExitCode(input)).toBe(expected);
  });

  it("resolves ABORTED ahead of every other signal in the precedence table", () => {
    expect(workflowExitCode(result({
      outcome: "ABORTED",
      validation: { valid: false, diagnostics: [{ code: "REQUIRED_ARTIFACT_MISSING", message: "x" }] },
      releaseRecommendation: "NOT_READY",
    }))).toBe(ExitCode.ABORTED_OR_INTERNAL);
  });

  it("resolves BLOCKED ahead of validation and gate signals", () => {
    expect(workflowExitCode(result({
      outcome: "BLOCKED",
      validation: { valid: false, diagnostics: [{ code: "REQUIRED_ARTIFACT_MISSING", message: "x" }] },
      releaseRecommendation: "NOT_READY",
    }))).toBe(ExitCode.BLOCKED);
  });

  it("resolves invalid validation ahead of a gate recommendation and COMPLETED_WITH_FAILURES", () => {
    expect(workflowExitCode(result({
      outcome: "COMPLETED_WITH_FAILURES",
      validation: { valid: false, diagnostics: [{ code: "REQUIRED_ARTIFACT_MISSING", message: "x" }] },
      releaseRecommendation: "READY",
    }))).toBe(ExitCode.UNMET_OBLIGATIONS);
  });

  it("resolves NOT_READY ahead of a COMPLETED_WITH_FAILURES fallback", () => {
    expect(workflowExitCode(result({
      outcome: "COMPLETED_WITH_FAILURES",
      validation: { valid: true, diagnostics: [] },
      releaseRecommendation: "NOT_READY",
    }))).toBe(ExitCode.UNMET_OBLIGATIONS);
  });
});
