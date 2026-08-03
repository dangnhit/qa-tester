import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";
import { loadQaConfig } from "../../src/config/load-config.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { runtimeVersion } from "../../src/installer/manifest.js";

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
  it("exposes the package version through the public CLI contract", async () => {
    const directory = await root();
    expect(await runCli(["--version"], { cwd: directory })).toEqual({
      exitCode: ExitCode.SUCCESS,
      stdout: `${runtimeVersion}\n`,
      stderr: "",
    });
  });

  it("uses the documented exact exit-code map", () => {
    expect(ExitCode).toEqual({ SUCCESS: 0, UNMET_OBLIGATIONS: 1, BLOCKED: 2, INVALID_INPUT: 3, SAFETY_DENIED: 4, ABORTED_OR_INTERNAL: 5 });
  });

  it("initializes config without overwriting existing gitignore entries", async () => {
    const directory = await root();
    await writeFile(join(directory, ".gitignore"), "node_modules/\n");
    const result = await runCli(["init"], { cwd: directory });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(await readFile(join(directory, "qa.config.yaml"), "utf8")).toContain("version:");
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toContain("node_modules/\nqa-results/\n");
  });

  it("writes an init config that loadQaConfig accepts without throwing", async () => {
    const directory = await root();
    const initialized = await runCli(["init"], { cwd: directory });
    expect(initialized.exitCode).toBe(ExitCode.SUCCESS);

    await expect(loadQaConfig({ cwd: directory })).resolves.toMatchObject({ snapshot: { version: 1 } });
  });

  it("publicly creates an unlocked nonterminal run workspace for standalone specialist skills", async () => {
    const directory = await root();
    const environmentPath = join(directory, "environment.json");
    await writeFile(environmentPath, JSON.stringify({
      artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "env-standalone", name: "Standalone", classification: "test", baseUrl: "https://test.example.test", productionReadOnly: false,
    }));

    const created = await runCli(["run", "create", "--root", directory, "--mode", "plan", "--environment-file", environmentPath], { cwd: directory });

    expect(created.exitCode).toBe(ExitCode.SUCCESS);
    const result = JSON.parse(created.stdout) as { runId: string; root: string; mode: string; status: string };
    expect(result).toMatchObject({ root: await realpath(directory), mode: "plan", status: "CREATED" });
    const workspace = await RunWorkspace.open(directory, result.runId);
    expect(workspace.mode).toBe("plan");
    await workspace.transition("RUNNING");
    await workspace.close();
  });

  it("lists skill execution kinds and reports invalid commands as invalid input", async () => {
    const directory = await root();
    const listed = await runCli(["skills", "list"], { cwd: directory });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain('"executionKind":"hybrid"');
    expect((await runCli(["wat"], { cwd: directory })).exitCode).toBe(ExitCode.INVALID_INPUT);
  });

  it("rejects runtime-owned artifacts at the Agent Draft boundary and emits machine-readable validate results", async () => {
    const directory = await root();
    const environmentProfile = {
      artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "env-test", name: "Test", classification: "test", baseUrl: "https://test.example.test", productionReadOnly: false,
    } as const;
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    await workspace.close();
    const sourcePath = join(directory, "run.json");
    await writeFile(sourcePath, JSON.stringify({ artifactType: "run-metadata", schemaVersion: "1.0.0", producerVersion: "1.0.0", runId: workspace.runId, status: "CREATED", createdAt: "2026-07-23T12:34:56.000Z", mode: "plan", environmentProfileId: "env-test" }));

    const ingested = await runCli(["artifact", "ingest", "--root", directory, "--run-id", workspace.runId, "--type", "run-metadata", "--file", sourcePath], { cwd: directory });
    expect(ingested.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(ingested.stderr).toMatch(/runtime-owned|agent draft/i);
    const valid = await runCli(["validate", "--root", directory, "--run-id", workspace.runId], { cwd: directory });
    expect(valid.exitCode).toBe(ExitCode.SUCCESS);
    expect(JSON.parse(valid.stdout)).toMatchObject({ valid: true, diagnostics: [] });
    const unmet = await runCli(["validate", "--root", directory, "--run-id", workspace.runId, "--profile", "full"], { cwd: directory });
    expect(unmet.exitCode).toBe(ExitCode.UNMET_OBLIGATIONS);
    expect(JSON.parse(unmet.stdout)).toMatchObject({ valid: false });
  });

  it("documents the successful init and artifact ingest commands as intentionally silent", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toContain("Successful `qa-skill init` and `qa-skill artifact ingest` are intentionally silent on stdout.");
  });
  it("routes governed planning artifacts through authority validation instead of low-level registration", async () => {
    const directory = await root();
    const environmentProfile = {
      artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "env-test", name: "Test", classification: "test", baseUrl: "https://test.example.test", productionReadOnly: false,
    } as const;
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    await workspace.close();
    const sourcePath = join(directory, "code-as-authoritative.json");
    await writeFile(sourcePath, JSON.stringify({
      artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA-1",
      statements: [{
        requirementId: "REQ-1", sourceProvenance: { kind: "code", reference: "controller.ts" }, normalizedText: "The current controller redirects.", authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [],
      }],
    }));

    const result = await runCli([
      "artifact", "ingest", "--root", directory, "--run-id", workspace.runId,
      "--type", "requirement-analysis", "--file", sourcePath,
    ], { cwd: directory });

    expect(result.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(result.stderr).toMatch(/authority.*provenance|provenance.*authority/i);
  });

  it("maps live locks, invalid input, and unexpected internal failures to their actual exit codes", async () => {
    const directory = await root();
    const environmentProfile = {
      artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "env-test", name: "Test", classification: "test", baseUrl: "https://test.example.test", productionReadOnly: false,
    } as const;
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    expect((await runCli(["validate", "--root", directory, "--run-id", workspace.runId], { cwd: directory })).exitCode).toBe(ExitCode.BLOCKED);
    await workspace.close();
    expect((await runCli(["artifact", "ingest", "--root", directory, "--run-id", workspace.runId, "--type", "unknown", "--file", "missing.json"], { cwd: directory })).exitCode).toBe(ExitCode.INVALID_INPUT);
    const filePath = join(directory, "not-a-directory");
    await writeFile(filePath, "file");
    expect((await runCli(["init"], { cwd: filePath })).exitCode).toBe(ExitCode.ABORTED_OR_INTERNAL);
  });

  it("maps path traversal and symlink escapes to the safety-denied exit code", async () => {
    const directory = await root();
    expect((await runCli(["validate", "--root", directory, "--run-id", "../../../outside"], { cwd: directory })).exitCode).toBe(ExitCode.SAFETY_DENIED);

    const outside = await root();
    await mkdir(join(directory, "qa-results"));
    await symlink(outside, join(directory, "qa-results", "linked-run"));
    expect((await runCli(["validate", "--root", directory, "--run-id", "linked-run"], { cwd: directory })).exitCode).toBe(ExitCode.SAFETY_DENIED);
  });

  // Item 2.3 (phase9-debt-clearing task 3): a missing root or missing run directory is a user typo, not
  // an internal crash. `RunWorkspace.open`'s bare `realpath` used to throw a raw, uncoded `ENOENT`, which
  // fell through `program.ts`'s catch-all to `ABORTED_OR_INTERNAL` (exit 5) with a filesystem path in the
  // message -- a CI script branching on the exit code to tell "bad input" from "the tool broke" got the
  // wrong branch, and the operator saw a raw Node path instead of the run ID they typed.
  it("refuses an unknown run id as bad input, not an internal error", async () => {
    const directory = await root();
    const run = await runCli(["validate", "--root", directory, "--run-id", "no-such-run"], { cwd: directory });
    expect(run.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(run.stderr).not.toMatch(/ENOENT/);
    expect(run.stderr).toMatch(/no-such-run/);
  });

  // A bad `--root` and a bad `--run-id` are different mistakes, and the message must say which one: a
  // caller who typos `--root` must not be told a run ID (that they typed correctly) "was not found" and
  // go hunting for the wrong argument.
  it("refuses a --root that does not exist with its own message, not the run-id refusal", async () => {
    const directory = await root();
    const run = await runCli(["validate", "--root", join(directory, "does-not-exist"), "--run-id", "no-such-run"], { cwd: directory });
    expect(run.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(run.stderr).not.toMatch(/ENOENT/);
    expect(run.stderr).toMatch(/project root does not exist/i);
    expect(run.stderr).not.toMatch(/no-such-run/);
  });

  // The constraint that matters most: only ENOENT is translated -- a permission or I/O error is a real
  // fault and must still surface as the internal error it is, not be folded into "bad run id". The
  // original provocation here (a root path climbing through a plain file) is platform-specific: POSIX's
  // realpath answers ENOTDIR for that shape, but Windows answers ENOENT for the identical path (measured
  // in CI run 30799759549), which the translation then legitimately narrows to INVALID_INPUT -- exactly
  // the folding this test exists to rule out. An embedded NUL byte sidesteps the divergence: Node
  // validates every fs path argument for one in plain JS, before the string ever reaches a
  // platform-specific syscall, so both platforms reject it identically with ERR_INVALID_ARG_VALUE rather
  // than ENOENT -- no `runIf` guard needed, the property holds everywhere.
  it("does not swallow a non-ENOENT realpath failure into invalid input", async () => {
    const directory = await root();
    const run = await runCli(["validate", "--root", `${directory}\0nested`, "--run-id", "no-such-run"], { cwd: directory });
    expect(run.exitCode).toBe(ExitCode.ABORTED_OR_INTERNAL);
    expect(run.stderr).toMatch(/null bytes/);
  });
});
