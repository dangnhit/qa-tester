import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Command, CommanderError } from "commander";

import { artifactTypes, type ArtifactType } from "../contracts/types.js";
import { artifactProfileNames, type ArtifactProfileName } from "../core/artifact-profiles.js";
import { QaSkillsError } from "../core/errors.js";
import { RunWorkspace } from "../core/run-workspace.js";
import { createRun } from "../operations/create-run.js";
import { ingestArtifact } from "../operations/ingest-artifact.js";
import { recordHumanApproval } from "../operations/record-human-approval.js";
import { bootstrapPlanningBundle, runLocalWorkflow, scaffoldWorkflowInput } from "./workflow.js";
import { isRuntimeCompatible, runtimeCompatibility, runtimeVersion } from "../installer/manifest.js";
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
  if (!(await exists(configPath))) await writeFile(configPath, "version: 1\n", "utf8");
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
  program.name("qa-skill").version(runtimeVersion).exitOverride();
  program.configureOutput({ writeOut: (value) => { stdout += value; }, writeErr: (value) => { stderr += value; } });
  program.command("init").action(async () => { await initialize(options.cwd); });
  program.command("run").command("create")
    .requiredOption("--root <path>").requiredOption("--mode <mode>").requiredOption("--environment-file <json>")
    .action(async (commandOptions: { root: string; mode: string; environmentFile: string }) => {
      if (!isProfile(commandOptions.mode)) throw new QaSkillsError("Unsupported artifact profile", "INVALID_ARTIFACT");
      const environmentProfile = JSON.parse(await readFile(commandOptions.environmentFile, "utf8")) as Record<string, unknown>;
      const workspace = await createRun({ root: commandOptions.root, mode: commandOptions.mode, environmentProfile });
      try {
        stdout += `${JSON.stringify({ runId: workspace.runId, root: workspace.root, mode: workspace.mode, status: "CREATED" })}\n`;
      } finally {
        await workspace.close();
      }
    });
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
  const workflowCommand = program.command("workflow");
  workflowCommand.command("run")
    .requiredOption("--input <json>")
    .action(async (commandOptions: { input: string }) => { stdout += `${JSON.stringify(await runLocalWorkflow({ cwd: options.cwd, inputPath: commandOptions.input }))}\n`; });
  workflowCommand.command("scaffold")
    .requiredOption("--root <path>").requiredOption("--mode <mode>").requiredOption("--output <path>")
    .option("--environment-file <json>").option("--source-root <path>").option("--source-run-id <id>")
    .action(async (commandOptions: { root: string; mode: string; output: string; environmentFile?: string; sourceRoot?: string; sourceRunId?: string }) => {
      stdout += `${JSON.stringify(await scaffoldWorkflowInput({ root: commandOptions.root, mode: commandOptions.mode, outputPath: commandOptions.output, ...(commandOptions.environmentFile === undefined ? {} : { environmentPath: commandOptions.environmentFile }), ...(commandOptions.sourceRoot === undefined ? {} : { sourceRoot: commandOptions.sourceRoot }), ...(commandOptions.sourceRunId === undefined ? {} : { sourceRunId: commandOptions.sourceRunId }) }))}\n`;
    });
  workflowCommand.command("bootstrap")
    .requiredOption("--root <path>").requiredOption("--environment-file <json>").requiredOption("--requirement-file <path>").requiredOption("--plan-file <path>")
    .requiredOption("--test-case-file <path>", "Canonical testcase file", (value, previous: string[]) => [...previous, value], [])
    .requiredOption("--coverage-file <path>", "Coverage obligation file", (value, previous: string[]) => [...previous, value], [])
    .action(async (commandOptions: { root: string; environmentFile: string; requirementFile: string; planFile: string; testCaseFile: string[]; coverageFile: string[] }) => {
      stdout += `${JSON.stringify(await bootstrapPlanningBundle({ root: commandOptions.root, environmentPath: commandOptions.environmentFile, requirementPath: commandOptions.requirementFile, planPath: commandOptions.planFile, testCasePaths: commandOptions.testCaseFile, coveragePaths: commandOptions.coverageFile }))}\n`;
    });
  program.command("runtime").command("verify").option("--range <semver>", "compatible runtime range", runtimeCompatibility)
    .action((commandOptions: { range: string }) => {
      if (!isRuntimeCompatible(runtimeVersion, commandOptions.range)) throw new QaSkillsError(`Runtime ${runtimeVersion} is not compatible with ${commandOptions.range}`, "INVALID_ARTIFACT");
      stdout += `${JSON.stringify({ executable: process.argv[1], version: runtimeVersion, range: commandOptions.range, compatible: true })}\n`;
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
  program.command("approval").command("record")
    .requiredOption("--root <path>")
    .requiredOption("--run-id <id>")
    .requiredOption("--plan-artifact-id <id>")
    .requiredOption("--approved-by <identity>")
    .action(async (commandOptions: { root: string; runId: string; planArtifactId: string; approvedBy: string }) => {
      stdout += `${JSON.stringify(await recordHumanApproval(commandOptions))}\n`;
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
      else if (error.code === "PATH_ESCAPE" || error.code === "SYMLINK_ESCAPE" || error.code === "INSTALLER_SAFETY") exitCode = ExitCode.SAFETY_DENIED;
      else exitCode = ExitCode.INVALID_INPUT;
    } else if (error instanceof CommanderError && error.code === "commander.version") {
      exitCode = ExitCode.SUCCESS;
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
