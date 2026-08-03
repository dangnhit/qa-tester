import { describe, expect, it, vi } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";
import { QaSkillsError } from "../../src/core/errors.js";

/**
 * The `execute playwright` REFUSAL-CODE to EXIT-CODE table in `src/cli/program.ts`, asked of the real
 * `runCli` with the operation stubbed out.
 *
 * **Why the operation is stubbed rather than driven.** Three of the four `OBSERVED_RUN_*` codes are
 * already pinned end to end — `OBSERVED_RUN_PRODUCTION_DENIED` by `tests/cli/execute-playwright.test.ts`,
 * and `OBSERVED_RUN_SPEC_OUTSIDE_ANCHOR` and `OBSERVED_RUN_ANCHOR_CHANGED` by
 * `tests/e2e/lane2-batch-credited-run.test.ts` against a real Playwright process. The fourth,
 * `OBSERVED_RUN_SPEC_LOCATION_UNKNOWN`, had none, and `program.ts` passes no `execute` seam and offers
 * no flag for one — adding one to make a test reachable is what this branch's Task 5 was told not to do.
 * So the mapping, which is production code and which nothing covered at all, is asked directly.
 * Same shape and same reasoning as `tests/cli/workflow-run-exit-code.test.ts`, which stubs
 * `runLocalWorkflow` for outcomes a real local run cannot practically reach in-process.
 *
 * **What is NOT claimed is that no end-to-end route exists — MEASURED, one does.** Playwright's JSON
 * reporter always emits `config.rootDir` (measured: a plain `--reporter=json` run writes it, absolute),
 * but the reporter is not the last writer of that file. A committed `playwright.config.js` carrying
 * `process.on("exit", …)` — the very actor `assertExecutedSpecsAreAnchored`'s TSDoc names, unanchored
 * code that outlives the reporter — rewrote the report with `config.rootDir` deleted, measured against
 * `@playwright/test` 1.61 on darwin. An e2e case in `tests/e2e/lane2-batch-credited-run.test.ts` is
 * therefore possible and needs no production change; it was left out of Task 5 as out of scope, not as
 * impossible, and this file does not stand in for it. What this file covers is the CLI half only.
 *
 * **What this therefore does NOT claim**: that `executeObservedPlaywright` can produce each of these
 * codes. That is `tests/observed/execute-observed-playwright.test.ts`'s to pin, and it does, for all
 * four. This file pins only the half that lives in the CLI: given the code, which exit does an operator
 * get. The unmapped row is what keeps the table honest — without it, a mutation that widened the
 * `SAFETY_DENIED` clause to accept everything would pass every other row.
 */
const { executeObservedPlaywrightMock } = vi.hoisted(() => ({ executeObservedPlaywrightMock: vi.fn() }));

vi.mock("../../src/operations/execute-observed-playwright.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/operations/execute-observed-playwright.js")>();
  return { ...actual, executeObservedPlaywright: executeObservedPlaywrightMock };
});

describe("qa-skill execute playwright refusal-code exit mapping", () => {
  it.each([
    ["OBSERVED_RUN_SPEC_LOCATION_UNKNOWN", ExitCode.SAFETY_DENIED],
    ["OBSERVED_RUN_SPEC_OUTSIDE_ANCHOR", ExitCode.SAFETY_DENIED],
    ["OBSERVED_RUN_ANCHOR_CHANGED", ExitCode.SAFETY_DENIED],
    ["OBSERVED_RUN_PRODUCTION_DENIED", ExitCode.SAFETY_DENIED],
    ["SPEC_TREE_DIRTY", ExitCode.BLOCKED],
    // Not on either list, and it must stay off both: every other observed refusal is INVALID_INPUT.
    ["OBSERVED_RUN_NO_ENTRIES", ExitCode.INVALID_INPUT],
  ] as const)("maps %s to the documented exit code", async (code, expected) => {
    executeObservedPlaywrightMock.mockRejectedValueOnce(new QaSkillsError(`refused for ${code}`, code));

    const result = await runCli(["execute", "playwright", "--root", "/tmp", "--run-id", "RUN-1", "--spec-dir", "specs"], { cwd: "/tmp" });

    expect(result.exitCode).toBe(expected);
    // The refusal's own words reach the operator, and nothing was written to stdout for a run that
    // registered nothing.
    expect(result.stderr).toContain(`refused for ${code}`);
    expect(result.stdout).toBe("");
  });
});
