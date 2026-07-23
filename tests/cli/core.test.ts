import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";

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
    expect(result.stdout).toBe("");
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

  it("ingests an artifact and emits machine-readable validate results with real exit outcomes", async () => {
    const directory = await root();
    const environmentProfile = {
      artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "env-test", name: "Test", classification: "test", baseUrl: "https://test.example.test", productionReadOnly: false,
    } as const;
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    await workspace.close();
    const sourcePath = join(directory, "run.json");
    await writeFile(sourcePath, JSON.stringify({ artifactType: "run-metadata", schemaVersion: "1.0.0", producerVersion: "1.0.0", runId: workspace.runId, status: "CREATED", createdAt: "2026-07-23T12:34:56.000Z", mode: "plan", environmentProfileId: "env-test" }));

    const ingested = await runCli(["artifact", "ingest", "--root", directory, "--run-id", workspace.runId, "--type", "run-metadata", "--file", sourcePath], { cwd: directory });
    expect(ingested.exitCode).toBe(ExitCode.SUCCESS);
    expect(ingested.stdout).toBe("");
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
});
