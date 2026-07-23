import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("compiled package consumer surface", () => {
  it("imports the public package entry and cannot reach the unsafe callback seam", async () => {
    await run("npm", ["run", "build"], { cwd: process.cwd() });
    const consumer = await import("@vigentix/qa-skills");
    expect(consumer.createQaTester).toEqual(expect.any(Function));
    expect(consumer.selectRegressionCases).toEqual(expect.any(Function));
    expect("createUnsafeWorkflowRunnerForTests" in consumer).toBe(false);
  });
});
