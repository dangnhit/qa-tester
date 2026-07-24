import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "qa-skills-cli-help-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("qa-skill --help exits 0 cleanly", () => {
  it("prints usage on stdout and leaves stderr clean for --help", async () => {
    const directory = await root();
    const result = await runCli(["--help"], { cwd: directory });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stdout).toContain("Usage: qa-skill");
    expect(result.stderr).not.toContain("(outputHelp)");
    expect(result.stderr.trim()).toBe("");
  });

  it("prints usage on stdout and leaves stderr clean for -h", async () => {
    const directory = await root();
    const result = await runCli(["-h"], { cwd: directory });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stdout).toContain("Usage: qa-skill");
    expect(result.stderr).not.toContain("(outputHelp)");
    expect(result.stderr.trim()).toBe("");
  });

  it("exits 0 with no leaked (outputHelp) token for the help command", async () => {
    const directory = await root();
    const result = await runCli(["help"], { cwd: directory });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stderr).not.toContain("(outputHelp)");
  });

  it("exits 0 with no leaked (outputHelp) token for bare invocation", async () => {
    const directory = await root();
    const result = await runCli([], { cwd: directory });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stderr).not.toContain("(outputHelp)");
  });

  it("exits 0 with no leaked (outputHelp) token for a subcommand's --help", async () => {
    const directory = await root();
    const result = await runCli(["skills", "--help"], { cwd: directory });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stdout).toContain("Usage: qa-skill skills");
    expect(result.stderr).not.toContain("(outputHelp)");
    expect(result.stderr.trim()).toBe("");
  });

  it("still exits 0 with the version on stdout (regression guard)", async () => {
    const directory = await root();
    const result = await runCli(["--version"], { cwd: directory });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(result.stderr).toBe("");
  });

  it("writes a genuine parse-error message exactly once to stderr", async () => {
    const directory = await root();
    const result = await runCli(["skills", "install"], { cwd: directory });

    expect(result.exitCode).not.toBe(ExitCode.SUCCESS);
    const occurrences = result.stderr.split("required option").length - 1;
    expect(occurrences).toBe(1);
  });

  it("documents the init command in top-level and subcommand help", async () => {
    const directory = await root();
    const topLevel = await runCli(["--help"], { cwd: directory });
    const initHelp = await runCli(["init", "--help"], { cwd: directory });

    expect(topLevel.stdout).toMatch(/init\s+Create project config/);
    expect(initHelp.stdout).toContain("Create project config");
  });
});
