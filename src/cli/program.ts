import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Command, CommanderError } from "commander";

import { agentDraftSkeletons, agentDraftTypes, isAgentDraftType } from "./artifact-drafts.js";
import { artifactTypes, type ArtifactType } from "../contracts/types.js";
import { schemas } from "../contracts/catalog.js";
import { artifactProfileNames, type ArtifactProfileName } from "../core/artifact-profiles.js";
import { QaSkillsError } from "../core/errors.js";
import { RunWorkspace } from "../core/run-workspace.js";
import { createRun } from "../operations/create-run.js";
import { ingestArtifact } from "../operations/ingest-artifact.js";
import { recordHumanApproval } from "../operations/record-human-approval.js";
import { sha256Fingerprint } from "../planning/testcase-revision.js";
import { bootstrapPlanningBundle, runLocalWorkflow, scaffoldWorkflowInput } from "./workflow.js";
import { isRuntimeCompatible, runtimeCompatibility, runtimeVersion } from "../installer/manifest.js";
import { isAgentName, isInstallTarget } from "../installer/agents.js";
import { installSkills } from "../installer/install.js";
import { uninstallSkills } from "../installer/uninstall.js";
import { updateSkills } from "../installer/update.js";
import { verifySkills } from "../installer/verify.js";
import { ExitCode, workflowExitCode, type ExitCode as ExitCodeValue } from "./exit-codes.js";

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
  program.name("qa-skill").description("Deterministic QA runtime and CLI: manage run workspaces, artifacts, skills, and workflows.").version(runtimeVersion).exitOverride();
  program.configureOutput({ writeOut: (value) => { stdout += value; }, writeErr: (value) => { stderr += value; } });
  program.command("init").description("Create project config and ignore qa-results/").action(async () => { await initialize(options.cwd); });
  program.command("run").description("Manage run workspaces").command("create")
    .description("Create a new run workspace")
    .requiredOption("--root <path>", "Project root directory")
    .requiredOption("--mode <mode>", "Artifact profile controlling validation scope")
    .requiredOption("--environment-file <json>", "Path to an environment profile JSON file")
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
  const skillsCommand = program.command("skills").description("Manage QA Skill installation for supported coding agents");
  skillsCommand.command("list").description("List available QA skills and their execution kind").action(() => { stdout += `${skills.map((skill) => JSON.stringify(skill)).join("\n")}\n`; });
  const configureSkillTarget = (command: Command, includeForce = false): Command => {
    command.requiredOption("--agent <agent>", "Target coding agent: codex, claude, or cursor").option("--target <scope>", "project or user", "project").option("--user-home <path>", "Override the user home directory used for user-scope installs");
    if (includeForce) command.option("--force", "Overwrite existing installed skill files");
    return command;
  };
  configureSkillTarget(skillsCommand.command("install").description("Install QA skills for an agent")).action(async (commandOptions: SkillCommandOptions) => {
    const result = await installSkills(installerOptions(commandOptions, options.cwd));
    stdout += `${JSON.stringify(result)}\n`;
  });
  configureSkillTarget(skillsCommand.command("verify").description("Verify installed QA skills against the runtime")).action(async (commandOptions: SkillCommandOptions) => {
    const result = await verifySkills(installerOptions(commandOptions, options.cwd));
    stdout += `${JSON.stringify(result)}\n`;
    if (result.status !== "valid") exitCode = ExitCode.UNMET_OBLIGATIONS;
  });
  configureSkillTarget(skillsCommand.command("update").description("Update installed QA skills to the current runtime version"), true).action(async (commandOptions: SkillCommandOptions) => {
    const result = await updateSkills({ ...installerOptions(commandOptions, options.cwd), ...(commandOptions.force ? { force: true } : {}) });
    stdout += `${JSON.stringify(result)}\n`;
  });
  configureSkillTarget(skillsCommand.command("uninstall").description("Remove installed QA skills")).action(async (commandOptions: SkillCommandOptions) => {
    const result = await uninstallSkills(installerOptions(commandOptions, options.cwd));
    stdout += `${JSON.stringify(result)}\n`;
    if (result.leftovers.length > 0) exitCode = ExitCode.UNMET_OBLIGATIONS;
  });
  const workflowCommand = program.command("workflow").description("Run and scaffold local QA workflows");
  workflowCommand.command("run")
    .description("Run a local workflow end-to-end from a JSON input file")
    .requiredOption("--input <json>", "Path to a workflow input JSON file")
    .action(async (commandOptions: { input: string }) => {
      const result = await runLocalWorkflow({ cwd: options.cwd, inputPath: commandOptions.input });
      stdout += `${JSON.stringify(result)}\n`;
      exitCode = workflowExitCode(result);
    });
  workflowCommand.command("scaffold")
    .description("Scaffold a workflow input JSON file from a run workspace or explicit paths")
    .requiredOption("--root <path>", "Project root directory")
    .requiredOption("--mode <mode>", "Artifact profile controlling validation scope")
    .requiredOption("--output <path>", "Path to write the scaffolded workflow input JSON")
    .option("--environment-file <json>", "Path to an environment profile JSON file")
    .option("--source-root <path>", "Root directory to copy an existing run's artifacts from")
    .option("--source-run-id <id>", "Run ID to copy artifacts from within --source-root")
    .action(async (commandOptions: { root: string; mode: string; output: string; environmentFile?: string; sourceRoot?: string; sourceRunId?: string }) => {
      stdout += `${JSON.stringify(await scaffoldWorkflowInput({ root: commandOptions.root, mode: commandOptions.mode, outputPath: commandOptions.output, ...(commandOptions.environmentFile === undefined ? {} : { environmentPath: commandOptions.environmentFile }), ...(commandOptions.sourceRoot === undefined ? {} : { sourceRoot: commandOptions.sourceRoot }), ...(commandOptions.sourceRunId === undefined ? {} : { sourceRunId: commandOptions.sourceRunId }) }))}\n`;
    });
  workflowCommand.command("bootstrap")
    .description("Bootstrap a planning bundle (requirement analysis, plan, test cases, coverage) into a workflow input")
    .requiredOption("--root <path>", "Project root directory")
    .requiredOption("--environment-file <json>", "Path to an environment profile JSON file")
    .requiredOption("--requirement-file <path>", "Path to a requirement analysis JSON file")
    .requiredOption("--plan-file <path>", "Path to a test plan JSON file")
    .requiredOption("--test-case-file <path>", "Canonical testcase file", (value, previous: string[]) => [...previous, value], [])
    .requiredOption("--coverage-file <path>", "Coverage obligation file", (value, previous: string[]) => [...previous, value], [])
    .action(async (commandOptions: { root: string; environmentFile: string; requirementFile: string; planFile: string; testCaseFile: string[]; coverageFile: string[] }) => {
      stdout += `${JSON.stringify(await bootstrapPlanningBundle({ root: commandOptions.root, environmentPath: commandOptions.environmentFile, requirementPath: commandOptions.requirementFile, planPath: commandOptions.planFile, testCasePaths: commandOptions.testCaseFile, coveragePaths: commandOptions.coverageFile }))}\n`;
    });
  program.command("runtime").description("Inspect the installed runtime").command("verify")
    .description("Verify the installed runtime version is compatible with a semver range")
    .option("--range <semver>", "Compatible runtime semver range", runtimeCompatibility)
    .action((commandOptions: { range: string }) => {
      if (!isRuntimeCompatible(runtimeVersion, commandOptions.range)) throw new QaSkillsError(`Runtime ${runtimeVersion} is not compatible with ${commandOptions.range}`, "INVALID_ARTIFACT");
      stdout += `${JSON.stringify({ executable: process.argv[1], version: runtimeVersion, range: commandOptions.range, compatible: true })}\n`;
    });
  program.command("schema").description("Inspect artifact JSON Schemas").command("show")
    .description("Print the JSON Schema for an artifact type")
    .requiredOption("--type <type>", "Artifact type")
    .action((commandOptions: { type: string }) => {
      if (!isArtifactType(commandOptions.type)) throw new QaSkillsError("Unsupported artifact type", "INVALID_ARTIFACT");
      stdout += `${JSON.stringify(schemas[commandOptions.type], null, 2)}\n`;
    });
  program.command("draft").description("Author agent-drafted artifacts").command("init")
    .description("Print a minimal valid draft skeleton for an agent-authored artifact type")
    .requiredOption("--type <type>", `Artifact type: ${agentDraftTypes.join(", ")}`)
    .action((commandOptions: { type: string }) => {
      if (!isArtifactType(commandOptions.type)) throw new QaSkillsError("Unsupported artifact type", "INVALID_ARTIFACT");
      if (!isAgentDraftType(commandOptions.type)) {
        throw new QaSkillsError(`${commandOptions.type} is runtime-owned; agent drafts exist only for ${agentDraftTypes.join(", ")}`, "INVALID_ARTIFACT");
      }
      if (commandOptions.type === "test-case") {
        stderr += "Note: test-case has no standalone `artifact ingest`; register it only via `qa-skill workflow bootstrap`. revisionId/instanceId below are placeholders -- compute them with `qa-skill fingerprint --file <this-file>` (revisionId is the fingerprint; instanceId is \"<testCaseId>--<first 16 hex characters of the fingerprint>\").\n";
      }
      stdout += `${JSON.stringify(agentDraftSkeletons[commandOptions.type], null, 2)}\n`;
    });
  program.command("fingerprint")
    .description("Compute the sha256 content fingerprint of a JSON file (matches a registered test-case's revisionId)")
    .requiredOption("--file <path>", "Path to a JSON file")
    .action(async (commandOptions: { file: string }) => {
      let content: unknown;
      try {
        content = JSON.parse(await readFile(resolve(commandOptions.file), "utf8"));
      } catch (error: unknown) {
        throw new QaSkillsError(`Unable to read or parse JSON at ${commandOptions.file}: ${error instanceof Error ? error.message : "unknown error"}`, "INVALID_ARTIFACT");
      }
      stdout += `${sha256Fingerprint(content)}\n`;
    });
  program.command("artifact").description("Manage QA artifacts within a run workspace").command("ingest")
    .description("Ingest an artifact file into a run workspace")
    .requiredOption("--root <path>", "Project root directory")
    .requiredOption("--run-id <id>", "Run workspace ID")
    .requiredOption("--type <type>", "Artifact type to ingest")
    .requiredOption("--file <path>", "Path to the artifact source file")
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
  program.command("approval").description("Manage human approvals recorded against a run").command("record")
    .description("Record a human approval decision for a plan artifact")
    .requiredOption("--root <path>", "Project root directory")
    .requiredOption("--run-id <id>", "Run workspace ID")
    .requiredOption("--plan-artifact-id <id>", "ID of the plan artifact being approved")
    .requiredOption("--approved-by <identity>", "Identity of the approver")
    .action(async (commandOptions: { root: string; runId: string; planArtifactId: string; approvedBy: string }) => {
      stdout += `${JSON.stringify(await recordHumanApproval(commandOptions))}\n`;
    });
  program.command("validate")
    .description("Validate a run workspace's artifacts against its profile")
    .requiredOption("--root <path>", "Project root directory")
    .requiredOption("--run-id <id>", "Run workspace ID")
    .option("--profile <name>", "Artifact profile to validate against")
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
    } else if (error instanceof CommanderError && (error.code === "commander.help" || error.code === "commander.helpDisplayed")) {
      // Help text is already written to stdout (or, for a bare/missing-command
      // invocation, to stderr) via the configured output streams above; the
      // thrown error's message is just the sentinel token "(outputHelp)" and
      // must not be echoed anywhere.
      exitCode = ExitCode.SUCCESS;
    } else if (error instanceof CommanderError) {
      // Commander already wrote this message through the configured `writeErr`
      // before throwing; appending `error.message` here would double it.
      exitCode = ExitCode.INVALID_INPUT;
    } else {
      stderr += `${error instanceof Error ? error.message : "Internal error"}\n`;
      exitCode = ExitCode.ABORTED_OR_INTERNAL;
    }
  }
  return { exitCode, stdout, stderr };
}
