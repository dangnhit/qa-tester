import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Command, CommanderError } from "commander";

import { artifactTypes, type ArtifactType } from "../contracts/types.js";
import { artifactProfileNames, type ArtifactProfileName } from "../core/artifact-profiles.js";
import { QaSkillsError } from "../core/errors.js";
import { RunWorkspace } from "../core/run-workspace.js";
import { ingestArtifact } from "../operations/ingest-artifact.js";
import { isAgentName, isInstallTarget } from "../installer/agents.js";
import { installSkills } from "../installer/install.js";
import { uninstallSkills } from "../installer/uninstall.js";
import { updateSkills } from "../installer/update.js";
import { verifySkills } from "../installer/verify.js";
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
  { name: "testcase-designer", executionKind: "agent-authored" },
  { name: "test-data-manager", executionKind: "runtime-backed" },
  { name: "browser-test-executor", executionKind: "runtime-backed" },
  { name: "evidence-collector", executionKind: "runtime-backed" },
  { name: "bug-reporter", executionKind: "runtime-backed" },
  { name: "qa-report-generator", executionKind: "runtime-backed" },
] as const;

type SkillCommandOptions = { agent: string; target: string; userHome?: string; force?: boolean };

function installerOptions(commandOptions: SkillCommandOptions, cwd: string) {
  if (!isAgentName(commandOptions.agent)) throw new QaSkillsError("Unsupported agent; use codex, claude, or cursor", "INVALID_ARTIFACT");
  if (!isInstallTarget(commandOptions.target)) throw new QaSkillsError("Unsupported target; use project or user", "INVALID_ARTIFACT");
  return { projectRoot: cwd, ...(commandOptions.userHome === undefined ? {} : { userHome: commandOptions.userHome }), agent: commandOptions.agent, target: commandOptions.target };
}

export async function runCli(argv: string[], options: CliOptions): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  let exitCode: ExitCodeValue = ExitCode.SUCCESS;
  const program = new Command();
  program.name("qa-skill").exitOverride();
  program.configureOutput({ writeOut: (value) => { stdout += value; }, writeErr: (value) => { stderr += value; } });
  program.command("init").action(async () => { await initialize(options.cwd); });
  const skillsCommand = program.command("skills");
  skillsCommand.command("list").action(() => { stdout += `${skills.map((skill) => JSON.stringify(skill)).join("\n")}\n`; });
  const configureSkillTarget = (command: Command, includeForce = false): Command => {
    command.requiredOption("--agent <agent>").option("--target <scope>", "project or user", "project").option("--user-home <path>");
    if (includeForce) command.option("--force");
    return command;
  };
  configureSkillTarget(skillsCommand.command("install")).action(async (commandOptions: SkillCommandOptions) => {
    const result = await installSkills(installerOptions(commandOptions, options.cwd));
    stdout += `${JSON.stringify(result)}\n`;
  });
  configureSkillTarget(skillsCommand.command("verify")).action(async (commandOptions: SkillCommandOptions) => {
    const result = await verifySkills(installerOptions(commandOptions, options.cwd));
    stdout += `${JSON.stringify(result)}\n`;
    if (result.status !== "valid") exitCode = ExitCode.UNMET_OBLIGATIONS;
  });
  configureSkillTarget(skillsCommand.command("update"), true).action(async (commandOptions: SkillCommandOptions) => {
    const result = await updateSkills({ ...installerOptions(commandOptions, options.cwd), ...(commandOptions.force ? { force: true } : {}) });
    stdout += `${JSON.stringify(result)}\n`;
  });
  configureSkillTarget(skillsCommand.command("uninstall")).action(async (commandOptions: SkillCommandOptions) => {
    const result = await uninstallSkills(installerOptions(commandOptions, options.cwd));
    stdout += `${JSON.stringify(result)}\n`;
    if (result.leftovers.length > 0) exitCode = ExitCode.UNMET_OBLIGATIONS;
  });
  program.command("artifact").command("ingest")
    .requiredOption("--root <path>")
    .requiredOption("--run-id <id>")
    .requiredOption("--type <type>")
    .requiredOption("--file <path>")
    .option("--relationship <id>", "Related artifact ID", (value, previous: string[]) => [...previous, value], [])
    .action(async (commandOptions: { root: string; runId: string; type: string; file: string; relationship: string[] }) => {
      if (!isArtifactType(commandOptions.type)) throw new QaSkillsError("Unsupported artifact type", "INVALID_ARTIFACT");
      await ingestArtifact({
        root: commandOptions.root,
        runId: commandOptions.runId,
        type: commandOptions.type,
        sourcePath: commandOptions.file,
        relationships: commandOptions.relationship,
      });
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
      if (error.code === "LIVE_LOCK") exitCode = ExitCode.BLOCKED;
      else if (error.code === "PATH_ESCAPE" || error.code === "SYMLINK_ESCAPE") exitCode = ExitCode.SAFETY_DENIED;
      else exitCode = ExitCode.INVALID_INPUT;
    } else if (error instanceof CommanderError) {
      stderr += `${error.message}\n`;
      exitCode = ExitCode.INVALID_INPUT;
    } else {
      stderr += `${error instanceof Error ? error.message : "Internal error"}\n`;
      exitCode = ExitCode.ABORTED_OR_INTERNAL;
    }
  }
  return { exitCode, stdout, stderr };
}
