import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "qa-skills-cli-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CLI core", () => {
  it("uses the documented exact exit-code map", () => {
    expect(ExitCode).toEqual({ SUCCESS: 0, UNMET_OBLIGATIONS: 1, BLOCKED: 2, INVALID_INPUT: 3, SAFETY_DENIED: 4, ABORTED_OR_INTERNAL: 5 });
  });

  it("initializes config without overwriting existing gitignore entries", async () => {
    const directory = await root();
    await writeFile(join(directory, ".gitignore"), "node_modules/\n");
    const result = await runCli(["init"], { cwd: directory });
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(directory, "qa.config.yaml"), "utf8")).toContain("version:");
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toContain("node_modules/\nqa-results/\n");
  });

  it("lists skill execution kinds and reports invalid commands as invalid input", async () => {
    const directory = await root();
    const listed = await runCli(["skills", "list"], { cwd: directory });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain('"executionKind":"hybrid"');
    expect((await runCli(["wat"], { cwd: directory })).exitCode).toBe(ExitCode.INVALID_INPUT);
  });
});
