import { describe, expect, it, vi } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";

// The action wiring under test lives entirely between `runLocalWorkflow`
// resolving and `runCli` returning; every non-SUCCESS branch of the
// precedence table is already exhaustively covered by the pure
// `workflowExitCode` unit tests. Stubbing `runLocalWorkflow` here proves the
// CLI action actually reads its return value and assigns `exitCode` from it,
// for outcomes (AWAITING_RUNTIME, a NOT_READY gate) that a real local run
// cannot practically reach in-process without a browser.
const { runLocalWorkflowMock } = vi.hoisted(() => ({ runLocalWorkflowMock: vi.fn() }));

vi.mock("../../src/cli/workflow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/workflow.js")>();
  return { ...actual, runLocalWorkflow: runLocalWorkflowMock };
});

describe("qa-skill workflow run CLI exit-code wiring", () => {
  it("assigns BLOCKED for a non-throwing AWAITING_RUNTIME result instead of leaving the default SUCCESS", async () => {
    runLocalWorkflowMock.mockResolvedValueOnce({
      runId: "RUN-AWAITING", mode: "full", outcome: "AWAITING_RUNTIME", operationOrder: [], outputs: {}, validation: { valid: true, diagnostics: [] },
    });

    const result = await runCli(["workflow", "run", "--input", "unused.json"], { cwd: "/tmp" });

    expect(result.exitCode).toBe(ExitCode.BLOCKED);
    expect(result.exitCode).not.toBe(ExitCode.SUCCESS);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "AWAITING_RUNTIME" });
  });

  it("assigns BLOCKED for a non-throwing AWAITING_OBSERVED_EXECUTION result instead of leaving the default SUCCESS", async () => {
    runLocalWorkflowMock.mockResolvedValueOnce({
      runId: "RUN-AWAITING-OBSERVED", mode: "regression", outcome: "AWAITING_OBSERVED_EXECUTION", operationOrder: [], outputs: {}, validation: { valid: true, diagnostics: [] },
      pendingObservedExecution: { operation: "execute-browser-test", command: "execute playwright", reason: "The run expects a Runtime-Observed Execution." },
    });

    const result = await runCli(["workflow", "run", "--input", "unused.json"], { cwd: "/tmp" });

    expect(result.exitCode).toBe(ExitCode.BLOCKED);
    expect(result.exitCode).not.toBe(ExitCode.SUCCESS);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "AWAITING_OBSERVED_EXECUTION" });
  });

  it("assigns UNMET_OBLIGATIONS for a NOT_READY release-gate recommendation on an otherwise-clean COMPLETED result", async () => {
    runLocalWorkflowMock.mockResolvedValueOnce({
      runId: "RUN-NOT-READY", mode: "full", outcome: "COMPLETED", operationOrder: [], outputs: {}, validation: { valid: true, diagnostics: [] }, releaseRecommendation: "NOT_READY",
    });

    const result = await runCli(["workflow", "run", "--input", "unused.json"], { cwd: "/tmp" });

    expect(result.exitCode).toBe(ExitCode.UNMET_OBLIGATIONS);
    expect(result.exitCode).not.toBe(ExitCode.SUCCESS);
  });

  it("leaves the default SUCCESS for a clean COMPLETED result with a READY gate", async () => {
    runLocalWorkflowMock.mockResolvedValueOnce({
      runId: "RUN-READY", mode: "full", outcome: "COMPLETED", operationOrder: [], outputs: {}, validation: { valid: true, diagnostics: [] }, releaseRecommendation: "READY",
    });

    const result = await runCli(["workflow", "run", "--input", "unused.json"], { cwd: "/tmp" });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
  });
});
