import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Command } from "commander";

import { artifactTypes, type ArtifactType } from "../contracts/types.js";
import { artifactProfileNames, type ArtifactProfileName } from "../core/artifact-profiles.js";
import { QaSkillsError } from "../core/errors.js";
import { RunWorkspace } from "../core/run-workspace.js";
import { ExitCode, type ExitCode as ExitCodeValue } from "./exit-codes.js";

export type CliResult = { exitCode: ExitCodeValue; stdout: string; stderr: string };
export type CliOptions = { cwd: string };

function isArtifactType(value: string): value is ArtifactType {
  return (artifactTypes as readonly string[]).includes(value);
}

function isProfile(value: string): value is ArtifactProfileName {
  return (artifactProfileNames as readonly string[]).includes(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function initialize(cwd: string): Promise<void> {
  const configPath = join(cwd, "qa.config.yaml");
  if (!(await exists(configPath))) await writeFile(configPath, "version: 1\nresultsDirectory: qa-results\n", "utf8");
  const ignorePath = join(cwd, ".gitignore");
  const existing = (await exists(ignorePath)) ? await readFile(ignorePath, "utf8") : "";
  if (!existing.split(/\r?\n/).includes("qa-results/")) await appendFile(ignorePath, `${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}qa-results/\n`, "utf8");
}

const skills = [
  { name: "qa-tester", executionKind: "hybrid" },
  { name: "requirement-analyzer", executionKind: "agent-authored" },
  { name: "browser-test-executor", executionKind: "runtime-backed" },
] as const;

export async function runCli(argv: string[], options: CliOptions): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  let exitCode: ExitCodeValue = ExitCode.SUCCESS;
  const program = new Command();
  program.name("qa-skill").exitOverride();
  program.configureOutput({ writeOut: (value) => { stdout += value; }, writeErr: (value) => { stderr += value; } });
  program.command("init").action(async () => { await initialize(options.cwd); });
  program.command("skills").command("list").action(() => { stdout += `${skills.map((skill) => JSON.stringify(skill)).join("\n")}\n`; });
  program.command("artifact").command("ingest")
    .requiredOption("--root <path>")
    .requiredOption("--run-id <id>")
    .requiredOption("--type <type>")
    .requiredOption("--file <path>")
    .option("--relationship <id>", "Related artifact ID", (value, previous: string[]) => [...previous, value], [])
    .action(async (commandOptions: { root: string; runId: string; type: string; file: string; relationship: string[] }) => {
      if (!isArtifactType(commandOptions.type)) throw new QaSkillsError("Unsupported artifact type", "INVALID_ARTIFACT");
      const workspace = await RunWorkspace.open(commandOptions.root, commandOptions.runId);
      try {
        await workspace.registerArtifact({ type: commandOptions.type, sourcePath: commandOptions.file, relationships: commandOptions.relationship, provenance: "agent-draft" });
      } finally {
        await workspace.close();
      }
    });
  program.command("validate")
    .requiredOption("--root <path>")
    .requiredOption("--run-id <id>")
    .option("--profile <name>")
    .action(async (commandOptions: { root: string; runId: string; profile?: string }) => {
      if (commandOptions.profile && !isProfile(commandOptions.profile)) throw new QaSkillsError("Unsupported artifact profile", "INVALID_ARTIFACT");
      const workspace = await RunWorkspace.open(commandOptions.root, commandOptions.runId);
      try {
        const result = await workspace.validate(commandOptions.profile as ArtifactProfileName | undefined);
        stdout += `${JSON.stringify(result)}\n`;
        if (!result.valid) exitCode = ExitCode.UNMET_OBLIGATIONS;
      } finally {
        await workspace.close();
      }
    });
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error: unknown) {
    if (error instanceof QaSkillsError) {
      stderr += `${error.message}\n`;
      exitCode = error.code === "LIVE_LOCK" ? ExitCode.BLOCKED : ExitCode.INVALID_INPUT;
    } else {
      stderr += `${error instanceof Error ? error.message : "Internal error"}\n`;
      exitCode = ExitCode.INVALID_INPUT;
    }
  }
  return { exitCode, stdout, stderr };
}
