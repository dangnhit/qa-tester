import { execFile } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { QaSkillsError } from "../core/errors.js";
import { assertRealpathWithin, resolveWithin } from "../core/fs.js";
import { resolveGitAnchor } from "../core/git-anchor.js";
import type { GitAnchor } from "../core/git-anchor.js";
import type { SafetyEnvironment } from "../safety/side-effects.js";

const runFile = promisify(execFile);

/** The one runner this module starts. Deliberately a constant rather than the `name` field of the
 *  package manifest it reads: the manifest is caller-controlled, and a value read from it would let a
 *  package planted at that path rename the runner in an immutable artifact. */
const runnerName = "@playwright/test";
const runnerCliRelativePath = join("node_modules", "@playwright", "test", "cli.js");
const runnerManifestRelativePath = join("node_modules", "@playwright", "test", "package.json");

/** The runtime owns both of these. Refused in whole-token form, so `--reporter`, `--reporter=json`
 *  and `--output=/tmp/x` are all caught; neither has a short alias in the runner's 1.61 CLI. */
const runtimeOwnedFlags = ["--reporter", "--output"] as const;

/** Generous on purpose: a runner can be noisy, and a truncated pipe surfaces as a killed child rather
 *  than as the observation the run produced. Matches the ceiling `src/core/git-anchor.ts:39` uses. */
const maxRunnerOutputBytes = 64 * 1024 * 1024;

/** What the runtime hands the process starter. `env` carries the report location, which is why a test
 *  seam can write a report exactly where a real runner would. */
export type RunnerInvocation = Readonly<{ command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }>;

/** How a started process ended. A discriminated union rather than two nullable fields, so "exited with
 *  a code" and "died by signal" are the only two states and neither caller nor implementation has an
 *  unreachable third case to guess at. */
export type RunnerExit = Readonly<{ exitCode: number; signal: null }> | Readonly<{ exitCode: null; signal: string }>;

/** Test seam for what a real run cannot produce on demand: a signal death, a spawn failure, and a
 *  runner that leaves no usable report. Everything else in this module is exercised for real. */
export type RunnerExecutor = (invocation: RunnerInvocation) => Promise<RunnerExit>;

/** The runner's JSON report, parsed and otherwise untouched. Deliberately unmodelled: mapping report
 *  entries onto QA test-case identity, execution surface, engine and viewport belongs to the producer,
 *  and a partial type here would read as a contract this module does not enforce. */
export type PlaywrightJsonReport = Readonly<Record<string, unknown>>;

export type ObservedPlaywrightRequest = Readonly<{
  /** Directory the runner runs from; also the root the runner is resolved under. */
  projectRoot: string;
  /** The Reviewed Test Suite's directory, absolute or relative to `projectRoot`. */
  specDir: string;
  /** The caller's own runner arguments, passed through verbatim except for the refusals below. */
  args: readonly string[];
  /** The QA Run's Environment Profile classification and its read-only opt-in. */
  environment: SafetyEnvironment;
  execute?: RunnerExecutor;
}>;

export type ObservedPlaywrightRun = Readonly<{
  /** The commit and spec-tree checksum resolved BEFORE the process started. */
  anchor: GitAnchor;
  /** The runner's exit status. Non-zero is an observation, not a refusal. */
  exitCode: number;
  report: PlaywrightJsonReport;
  runner: string;
  runnerVersion: string;
  startedAt: string;
  finishedAt: string;
}>;

/** Normalizes one real `execFile` outcome into the two states `RunnerExit` allows. A genuine spawn
 *  failure (`code` is a string such as `ENOENT`) is rethrown, because it produced no run to report. */
const defaultExecutor: RunnerExecutor = async (invocation) => {
  try {
    await runFile(invocation.command, [...invocation.args], { cwd: invocation.cwd, env: invocation.env, encoding: "utf8", maxBuffer: maxRunnerOutputBytes });
    return { exitCode: 0, signal: null };
  } catch (error: unknown) {
    const failure = error as { code?: unknown; signal?: unknown };
    if (typeof failure.signal === "string") return { exitCode: null, signal: failure.signal };
    if (typeof failure.code === "number") return { exitCode: failure.code, signal: null };
    throw error;
  }
};

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts one **Runtime-Observed Execution** (CONTEXT.md:135-137): it runs the caller's committed
 * Playwright suite as a child process and returns what it observed. It registers nothing, opens no
 * Run Workspace and writes no artifact — turning this return value into a `test-result-batch` and its
 * `runner-report` evidence belongs to the producer that calls it.
 *
 * **The anchor is resolved before the process starts, and a refusal means no process starts at all.**
 * A spec tree that differs from its commit produces no observed execution (CONTEXT.md:344), and a
 * refusal that arrived after the run would leave a finished process whose result cannot be recorded.
 * Two of `resolveGitAnchor`'s refusals are ordinary rather than exotic and reach the caller verbatim:
 * a sparse checkout sets `--skip-worktree` on every path outside the cone (`SPEC_TREE_INDEX_FLAGGED`),
 * and a repository-root `specDir` refuses because `node_modules/` is ignored and listed
 * (`SPEC_TREE_DIRTY`). Both are correct fail-closed behaviour, and both carry the offending paths in
 * their message so they do not read as an internal error.
 *
 * **The runner is `<projectRoot>/node_modules/@playwright/test/cli.js` and nothing else.** Never
 * `PATH`, never `npx`, never a caller-supplied binary path: a Skill Installation invokes only its
 * compatible local Runtime Binding and never downloads an executable during QA execution
 * (CONTEXT.md:385). This is `src/installer/agents.ts`'s rule minus its `PATH` fallback
 * (`agents.ts:59-77`), which lane 2 drops because the runner here executes caller-authored specs.
 *
 * **The process is `process.execPath` with `[cli.js, "test", ...]`, never the `.bin` shim and never a
 * shell.** On Windows the `.bin` entry is a `.cmd`, and Node cannot spawn a `.cmd` without a shell —
 * routing caller-supplied arguments through `cmd.exe` would be a command-injection surface.
 * `agents.ts`'s Windows branch is safe only because its argument is the fixed literal `--version`;
 * these arguments are not fixed. Going through `process.execPath` removes the class cross-platform.
 *
 * **One deliberate asymmetry:** the `cwd` is pinned with `assertRealpathWithin`, so the runner starts
 * from a physical path and a symlinked project root cannot make the runner's own path resolution
 * disagree with ours. The resolved `cli.js` is **not** realpath-asserted, and that is not an
 * oversight: pnpm and yarn stores legitimately link `node_modules` entries outside the project tree,
 * and asserting containment there would refuse correct installs. Containment of the *lexical* path
 * under `projectRoot` is still enforced (`resolveWithin`), so no caller input can point it elsewhere —
 * there is no caller input for it in the first place.
 *
 * **`--reporter` and `--output` are refused in the caller's arguments, not silently overridden.** The
 * runtime owns both, and a silent override is a divergence the caller cannot see.
 *
 * **The runner's output directory is forced outside `specDir`.** `resolveGitAnchor`'s contract states
 * that runner output must live outside the spec directory, because the dirty check refuses gitignored
 * files as well as untracked ones: Playwright's default `test-results/` landing under `specDir` would
 * make every later anchor refuse, so one successful run would poison every run after it. This is
 * closed structurally rather than by warning — both the artifact directory and the JSON report go in a
 * fresh `mkdtemp` directory outside the repository, so no configuration can put them under `specDir`.
 * The directory is not removed on the way out: `result.attachments[].path` and
 * `config.projects[].outputDir` in the returned report point into it, and that is how a producer
 * reaches the traces and screenshots the run left behind.
 *
 * **The report is captured as a file, not scraped from stdout.** Verified against the installed 1.61.1
 * runner rather than taken from documentation: its `JSONReporter` resolves its destination through
 * `PLAYWRIGHT_JSON_OUTPUT_FILE` first, ahead of `PLAYWRIGHT_JSON_OUTPUT_DIR`/`_NAME` and ahead of any
 * reporter option, so setting it pins the path unconditionally. stdout and stderr are still captured
 * with a large `maxBuffer` so a noisy runner does not surface as a spawn error.
 *
 * **What is a refusal and what is an observation:**
 * - A non-zero exit with a valid report is an **observation**. Test failures are what lane 2 exists to
 *   record, and refusing them would discard the result.
 * - **Death by signal is a refusal.** A killed runner produced no trustworthy result, and the evidence
 *   contract for a `runner-report` has no `signal` field precisely because this refuses here.
 * - A **missing, empty or unparseable report is a refusal.** An exit code alone is not an observation.
 *
 * **Production gating mirrors `src/safety/side-effects.ts:12-15`**: a `production` classification
 * refuses unless `productionReadOnly` is true (CONTEXT.md:370, ADR-0004). The classification is an
 * input; this module never reads it from a workspace.
 *
 * **State the residue plainly.** `productionReadOnly` bounds what the runtime's *own* Test DSL may do.
 * It does not and cannot bound what an external suite does — the runtime is observing a process, not
 * interpreting its steps, and that suite may write to anything its own code reaches. The gate is the
 * human's recorded decision that this suite may run against production, not a proof that it is safe.
 *
 * **No timeout.** The runner owns its own timeouts; a QA-imposed kill would destroy the report this
 * whole path exists to capture, and the kill would then be refused as a signal death. A hung suite is
 * the caller's to interrupt.
 *
 * **Nothing the caller typed is recorded.** No argv and no environment appear anywhere in the return
 * value, because caller-supplied arguments can carry a resolved secret (CONTEXT.md:371) and the
 * evidence contract deliberately has no `command` field. The runner's own report is the one back door:
 * 1.61.1 serializes the full process argv into `config.argv`, so that key is removed from the parsed
 * report before it is returned. Note the report *file left on disk* still contains it — a producer that
 * registers that file verbatim as evidence would reintroduce exactly what this strips.
 *
 * Every failure is a `QaSkillsError`; no raw error escapes.
 */
export async function runObservedPlaywright(request: ObservedPlaywrightRequest): Promise<ObservedPlaywrightRun> {
  try {
    return await observePlaywright(request);
  } catch (error: unknown) {
    if (error instanceof QaSkillsError) throw error;
    // Structural, not a classifier: src/cli/program.ts maps a raw Error to ABORTED_OR_INTERNAL rather
    // than to a refusal, so a module whose whole contract is "refuse cleanly" must never emit one.
    throw new QaSkillsError(`Unable to observe a ${runnerName} run in ${request.projectRoot}: ${describeFailure(error)}`, "OBSERVED_RUN_FAILED");
  }
}

async function observePlaywright(request: ObservedPlaywrightRequest): Promise<ObservedPlaywrightRun> {
  assertEnvironmentPermitsRun(request.environment);
  assertCallerArguments(request.args);

  const cwd = await assertRealpathWithin(request.projectRoot, request.projectRoot);
  const cliJs = await resolveRunnerCli(request.projectRoot);
  const runnerVersion = await readRunnerVersion(request.projectRoot);
  const anchor = await resolveGitAnchor({ projectRoot: request.projectRoot, specDir: request.specDir });

  const workDir = await mkdtemp(join(tmpdir(), "qa-skills-observed-"));
  const reportPath = join(workDir, "report.json");
  // The runtime's own flags precede the caller's deliberately: `--` ends option parsing in the runner's
  // argument parser, so a caller-supplied `--` placed before them would demote `--reporter=json` to a
  // test filter and hand the reporter choice back to the caller's configuration.
  const args = [cliJs, "test", "--reporter=json", `--output=${join(workDir, "artifacts")}`, ...request.args];
  const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath };

  const startedAt = new Date().toISOString();
  const exit = await startRunner(request.execute ?? defaultExecutor, { command: process.execPath, args, cwd, env });
  const finishedAt = new Date().toISOString();

  if (exit.signal !== null) {
    throw new QaSkillsError(
      `The ${runnerName} run in ${cwd} was killed by ${exit.signal} and produced no trustworthy result. A signal death is refused rather than recorded: `
      + `the observed-execution evidence contract has no field to say the run was killed, so recording it would assert a result nobody observed.`,
      "OBSERVED_RUN_KILLED_BY_SIGNAL",
    );
  }

  return { anchor, exitCode: exit.exitCode, report: await readRunnerReport(reportPath, exit.exitCode), runner: runnerName, runnerVersion, startedAt, finishedAt };
}

function assertEnvironmentPermitsRun(environment: SafetyEnvironment): void {
  if (environment.classification !== "production" || environment.productionReadOnly) return;
  throw new QaSkillsError(
    "A production Environment Profile requires an explicit read-only opt-in before the QA Runtime starts an external test suite against it. "
    + "Set productionReadOnly on the environment, or run against a non-production profile.",
    "OBSERVED_RUN_PRODUCTION_DENIED",
  );
}

function assertCallerArguments(args: readonly string[]): void {
  for (const argument of args) {
    const owned = runtimeOwnedFlags.find((flag) => argument === flag || argument.startsWith(`${flag}=`));
    if (owned === undefined) continue;
    throw new QaSkillsError(
      `The QA Runtime owns ${owned} and refuses it in caller arguments (received ${JSON.stringify(argument)}). It pins the reporter so the run produces a `
      + `machine-readable report, and pins the output directory outside the spec directory so a run cannot make every later git anchor refuse. `
      + `An explicit refusal is used instead of a silent override, which the caller could not see.`,
      "OBSERVED_RUN_ARGUMENT_REFUSED",
    );
  }
}

async function resolveRunnerCli(projectRoot: string): Promise<string> {
  const cliJs = resolveWithin(projectRoot, runnerCliRelativePath);
  try {
    await access(cliJs);
  } catch {
    throw new QaSkillsError(
      `No ${runnerName} runner is installed at ${cliJs}. Install it in this project (\`npm install --save-dev ${runnerName}\`). `
      + `The QA Runtime never resolves a runner from PATH, through npx, or from a caller-supplied path, so no globally installed playwright is used.`,
      "OBSERVED_RUNNER_MISSING",
    );
  }
  return cliJs;
}

async function readRunnerVersion(projectRoot: string): Promise<string> {
  const manifestPath = resolveWithin(projectRoot, runnerManifestRelativePath);
  const version = await readFile(manifestPath, "utf8")
    .then((raw) => (JSON.parse(raw) as { version?: unknown }).version)
    .catch(() => undefined);
  if (typeof version !== "string" || version.length === 0) {
    throw new QaSkillsError(`Unable to read the installed ${runnerName} version from ${manifestPath}; an observed execution records the runner version that ran.`, "OBSERVED_RUNNER_VERSION_UNREADABLE");
  }
  return version;
}

async function startRunner(execute: RunnerExecutor, invocation: RunnerInvocation): Promise<RunnerExit> {
  try {
    return await execute(invocation);
  } catch (error: unknown) {
    throw new QaSkillsError(`Unable to start the ${runnerName} runner in ${invocation.cwd}: ${describeFailure(error)}`, "OBSERVED_RUN_SPAWN_FAILED");
  }
}

async function readRunnerReport(reportPath: string, exitCode: number): Promise<PlaywrightJsonReport> {
  const raw = await readFile(reportPath, "utf8").catch(() => undefined);
  const context = `The ${runnerName} run exited ${exitCode} but`;
  if (raw === undefined) throw new QaSkillsError(`${context} wrote no JSON report at ${reportPath}. An exit code alone is not an observation, so this is refused rather than recorded.`, "OBSERVED_RUN_REPORT_MISSING");
  if (raw.trim().length === 0) throw new QaSkillsError(`${context} its JSON report at ${reportPath} is empty. An exit code alone is not an observation, so this is refused rather than recorded.`, "OBSERVED_RUN_REPORT_EMPTY");

  const parsed: unknown = await Promise.resolve()
    .then(() => JSON.parse(raw) as unknown)
    .catch(() => undefined);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new QaSkillsError(`${context} its JSON report at ${reportPath} is not a JSON object. An exit code alone is not an observation, so this is refused rather than recorded.`, "OBSERVED_RUN_REPORT_UNPARSEABLE");
  }
  return withoutCallerArgv(parsed as Record<string, unknown>);
}

/** Removes the one key the runner's own report uses to echo the process argv back. 1.61.1 writes the
 *  full argv — including every caller-supplied argument — to `config.argv`, and a caller argument can
 *  carry a resolved secret, so returning it would reintroduce through the report exactly what the
 *  evidence contract omits. Nothing else in the report is altered. */
function withoutCallerArgv(report: Record<string, unknown>): PlaywrightJsonReport {
  const config: unknown = report.config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) return report;
  return { ...report, config: Object.fromEntries(Object.entries(config as Record<string, unknown>).filter(([key]) => key !== "argv")) };
}
