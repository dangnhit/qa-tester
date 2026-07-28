import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { QaSkillsError } from "../core/errors.js";
import { assertRealpathWithin } from "../core/fs.js";
import { createEntityId } from "../core/ids.js";
import { RunWorkspace, type RegisteredWorkspaceArtifact } from "../core/run-workspace.js";
import { array, isRecord } from "../core/values.js";
import { runtimeVersion } from "../installer/manifest.js";
import { mapObservedReport, observedSpecFiles, type ExcludedSpec, type ObservedEntry, type RegisteredCase } from "../observed/report-mapping.js";
import { runObservedPlaywright, type PlaywrightJsonReport, type RunnerExecutor } from "../observed/run-playwright.js";
import { sanitizeRunnerReport } from "../observed/sanitize-report.js";
import type { SafetyEnvironment } from "../safety/side-effects.js";

export type ObservedPlaywrightExecution = Readonly<{
  executionId: string;
  batchArtifactId: string;
  evidenceArtifactId: string;
  commitSha: string;
  specTreeSha256: string;
  exitCode: number;
  entryCount: number;
  excluded: readonly ExcludedSpec[];
  /** Where the runtime left the runner's own output, so the escape hatch this producer's evidence
   *  deliberately does not carry is findable instead of guessable — see {@link runnerWorkingDirOf}.
   *  Absent only when the report named no project output directory. */
  runnerWorkingDir?: string;
}>;

export type ObservedPlaywrightExecutionInput = Readonly<{
  /** Project root: the run workspace's root, the runner's working directory, and the git repository. */
  root: string;
  runId: string;
  /** The Reviewed Test Suite's directory, absolute or relative to `root`. */
  specDir: string;
  /** The caller's own runner arguments, passed through verbatim after `--`. */
  args: readonly string[];
  /** Internal runtime seam for the runner process; the CLI never sets it. */
  execute?: RunnerExecutor;
}>;

const classifications: ReadonlySet<string> = new Set(["local", "test", "staging", "production"]);

/**
 * The run's own Environment Profile, read from the workspace rather than taken as a flag.
 *
 * A `--production-read-only` flag would let the caller assert the very thing CONTEXT.md:370 and
 * ADR-0004 make a recorded, reviewed property of the environment. The profile is registered once, at
 * run creation, and is immutable; reading it here is what makes the production gate a property of the
 * run instead of a property of the command line.
 *
 * Fail closed. Registration already guarantees exactly one profile with a schema-valid classification
 * (`RunWorkspace.create` registers it and `assertArtifactBinding` refuses a second), so this refusal is
 * unreachable through any supported path — which is exactly why it must not be a silent default: a
 * missing classification defaulting to "not production" would turn an unreadable profile into a
 * permitted production run.
 */
function environmentOf(artifacts: readonly RegisteredWorkspaceArtifact[]): SafetyEnvironment {
  const profiles = artifacts.filter((artifact) => artifact.record.type === "environment-profile");
  const value = profiles.length === 1 ? profiles[0]?.value : undefined;
  const classification = value?.classification;
  if (typeof classification !== "string" || !classifications.has(classification) || typeof value?.productionReadOnly !== "boolean") {
    throw new QaSkillsError(
      "This run does not carry exactly one readable Environment Profile, so the QA Runtime cannot tell whether the target is production. "
      + "An observed execution is refused rather than run against an environment nobody classified.",
      "OBSERVED_RUN_ENVIRONMENT_UNREADABLE",
    );
  }
  return { classification: classification as SafetyEnvironment["classification"], productionReadOnly: value.productionReadOnly };
}

function registeredCases(artifacts: readonly RegisteredWorkspaceArtifact[]): { cases: RegisteredCase[]; artifactIdOf: (entry: ObservedEntry) => string | undefined } {
  const testCases = artifacts.filter((artifact) => artifact.record.type === "test-case");
  const identity = (value: Readonly<Record<string, unknown>>): string => `${String(value.testCaseId)}/${String(value.revisionId)}/${String(value.instanceId)}`;
  const byIdentity = new Map(testCases.map((artifact) => [identity(artifact.value), artifact.record.id]));
  return {
    cases: testCases.map((artifact) => ({ testCaseId: String(artifact.value.testCaseId), testCaseRevisionId: String(artifact.value.revisionId), testCaseInstanceId: String(artifact.value.instanceId) })),
    artifactIdOf: (entry) => byIdentity.get(`${entry.testCaseId}/${entry.testCaseRevisionId}/${entry.testCaseInstanceId}`),
  };
}

/** The label used in refusal messages raised here rather than by the spawn primitive. */
const runnerLabel = "@playwright/test";

function describeExcluded(excluded: readonly ExcludedSpec[]): string {
  return excluded.map((spec) => `- ${JSON.stringify(spec.title)} (${spec.file}): ${spec.reason}`).join("\n");
}

/**
 * **Refuses an execution that ran any spec the git anchor does not describe.**
 *
 * The anchor is computed over `--spec-dir` alone, but nothing constrains the runner to that directory:
 * `runObservedPlaywright` refuses only `--reporter` and `--output`, so a caller's `--config` reaches
 * the runner untouched, and an ordinary project's `playwright.config` may simply declare a `testDir`
 * broader than `--spec-dir`. Either way the batch would record a `commitSha` and a `specTreeSha256`
 * describing a tree that is not the tree that ran, and — since the identity tag is trusted precisely
 * because it lives inside the anchored, reviewed tree — a spec outside it could earn coverage credit
 * having been reviewed by nobody. That is CONTEXT.md:344-345 with no other refusal in the way.
 *
 * **Every executed spec is checked, and one failure refuses the whole execution.** Not excluding the
 * offenders: excluding would still register a batch whose `specTreeSha256` claims to describe the tree
 * that ran while something outside it also ran. The anchor is a statement about the execution as a
 * unit, so one unanchored spec falsifies it for all of them — and nothing has been registered at this
 * point, so refusing costs no partial state.
 *
 * Containment is `assertRealpathWithin`'s, not a string prefix: `specs2/` must not satisfy `specs/`,
 * and a symlink out of the anchored directory must not either. Anything that cannot be placed — a
 * report with no `config.rootDir`, a spec file with no name, a path that no longer resolves — is
 * refused with the rest, because "could not prove it is inside" and "is outside" have the same
 * consequence for the anchor.
 */
async function assertExecutedSpecsAreAnchored(root: string, specDir: string, report: PlaywrightJsonReport): Promise<void> {
  const files = observedSpecFiles(report);
  if (files.length === 0) return;
  const config = report.config;
  const rootDir = isRecord(config) && typeof config.rootDir === "string" && config.rootDir.length > 0 ? config.rootDir : undefined;
  if (rootDir === undefined) {
    throw new QaSkillsError(
      `The runner's report names no config.rootDir, so the QA Runtime cannot say where the ${files.length} spec file(s) it executed live and cannot confirm they are the ones `
      + `${specDir} anchors. An observed execution is refused rather than recorded against a spec-tree checksum that may not describe it.`,
      "OBSERVED_RUN_SPEC_LOCATION_UNKNOWN",
    );
  }
  const anchored = await realpath(resolve(root, specDir));
  const unanchored: string[] = [];
  for (const file of files) {
    // Both sides are made physical BEFORE containment is judged. `assertRealpathWithin` starts with a
    // LEXICAL check of its candidate, and the runner's `config.rootDir` need not be spelled the way
    // the anchored directory resolves — on macOS a project under `/tmp` or `/var` reaches the same
    // inode through a symlinked prefix. Comparing those two spellings would refuse a perfectly
    // anchored spec, which is a false refusal rather than a safe one, so the spec path is resolved
    // first and `assertRealpathWithin` then re-checks it lexically AND physically.
    const physical = file.length === 0 ? undefined : await realpath(resolve(rootDir, file)).catch(() => undefined);
    const located = physical === undefined ? undefined : await assertRealpathWithin(anchored, physical).catch(() => undefined);
    if (located === undefined) unanchored.push(file.length === 0 ? "(a spec the runner reported with no file)" : physical ?? resolve(rootDir, file));
  }
  if (unanchored.length > 0) {
    throw new QaSkillsError(
      `The ${runnerLabel} run executed spec files outside ${anchored}, which is the only directory this run's git anchor covers. Their contents are not in `
      + `specTreeSha256 and no human accepted them as part of this Reviewed Test Suite, so crediting coverage from them would be crediting unreviewed code. `
      + `The whole execution is refused rather than these entries dropped: the anchor describes the run as a unit, and one unanchored spec falsifies it for every entry. `
      + `Narrow the suite to the anchored directory (a broader testDir in your Playwright config is the usual cause) or point --spec-dir at the directory that really ran:\n`
      + unanchored.map((file) => `- ${file}`).join("\n"),
      "OBSERVED_RUN_SPEC_OUTSIDE_ANCHOR",
    );
  }
}

/**
 * The temporary directory `runObservedPlaywright` gave the runner, holding its verbatim `report.json`
 * and its `artifacts/` (traces, screenshots, the files `attachments[].path` pointed at). Surfaced
 * because the registered evidence deliberately drops every failure message, and an escape hatch the
 * operator can only find by guessing among accumulated `/tmp/qa-skills-observed-*` directories is not
 * an escape hatch.
 *
 * **Derived, and the derivation is stated because it is not observed.** The spawn primitive forces
 * `--output=<workDir>/artifacts`, and Playwright's `--output` is the FIRST fallback for every
 * project's `outputDir` (`node_modules/playwright/lib/common/index.js`,
 * `takeFirst(configCLIOverrides.outputDir, …)`), so a project's reported `outputDir` is exactly that
 * forced path and its parent is the working directory. `tests/e2e/lane2-batch-credited-run.test.ts`
 * pins the derivation against a REAL run by asserting `report.json` and `artifacts/` are both in the
 * directory this returns, so a runner that changed the layout reddens rather than leaving the command
 * printing a path with nothing in it.
 */
function runnerWorkingDirOf(report: PlaywrightJsonReport): string | undefined {
  const config = report.config;
  const outputDir = (isRecord(config) ? array(config.projects) : [])
    .map((project) => isRecord(project) ? project.outputDir : undefined)
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return outputDir === undefined ? undefined : dirname(outputDir);
}

/**
 * Runs one **Reviewed Test Suite** as a **Runtime-Observed Execution** and registers what was observed:
 * one `test-result-batch` carrying the git anchor and one entry per identified spec, plus one
 * `runner-report` **Evidence Item** carrying the sanitized reporter payload.
 *
 * **This is lane 2's only producer, and it is the whole of ADR-0010's human-authored lane.** The
 * runtime spawns the runner, captures its exit status and output itself, and stamps `runtime-observed`
 * — the provenance both coverage readers gate credit on. A report file handed to the runtime by any
 * other route stays an Agent Draft and credits nothing (CONTEXT.md:341-342).
 *
 * **What each artifact says, and what it deliberately does not:**
 *
 * - The batch's `commitSha` and `specTreeSha256` come from `resolveGitAnchor`, which ran BEFORE the
 *   process started; a spec tree that differs from its commit produces no observed execution at all
 *   (CONTEXT.md:344). **And what ran is checked against what the anchor covers** — see
 *   {@link assertExecutedSpecsAreAnchored}, without which a caller's `--config`, or an ordinary project
 *   whose `testDir` is broader than `--spec-dir`, would credit coverage from files the checksum never
 *   hashed. No entry names an `observedEngine` or a `viewport`, because no entry names the `browser`
 *   surface: `mapObservedReport` refuses one, and the schema forbids both fields elsewhere.
 * - The evidence carries `sanitizeRunnerReport`'s projection, not the report file the runner wrote. The
 *   descriptor's `sha256` is therefore the checksum of what was registered — the file on disk still
 *   holds `config.argv` and, for an ordinary web project, `config.webServer.env`, and registering it
 *   would put a resolved secret in an immutable artifact (CONTEXT.md:371). That file is still readable,
 *   and the result's `runnerWorkingDir` says where.
 * - Evidence is attached to every NON-PASSING entry — which for this mapping means `FAILED`, `NOT_RUN`
 *   and `BLOCKED` — since one report substantiates the whole execution. `testResultBatchRule` enforces
 *   only the negative half of that (a `PASSED` entry must NOT declare evidence); attaching it to the
 *   others is this producer's choice, not the rule's requirement. The batch declares the evidence
 *   artifact as a relationship as well as inside the entry, which the rule does require.
 *
 * **Excluded is not refused.** A spec with no identity tag, or one naming a test case this run never
 * registered, is reported on the result rather than carried: the batch rule requires every entry to
 * match exactly one registered `test-case`, and an external suite legitimately holds specs this QA Run
 * never planned. A run in which NOTHING resolved is refused, because a batch with no entry cannot be
 * registered and a silent no-op would read as success.
 *
 * **Everything that can refuse runs before the first write**, so no refusal leaves a half-written
 * observation. One residue is disclosed rather than claimed away: the evidence bundle is registered
 * BEFORE the batch, because an entry has to cite the descriptor's id, so a failure registering the
 * batch leaves an `observed-execution` evidence artifact no batch claims. That state is inert and
 * deliberately legal — `semantic-rules.ts` rules out the reverse-direction check and sets out why an
 * unclaimed observed-execution item buys nothing anywhere — so the workspace stays valid and readable.
 *
 * Refusals from `resolveGitAnchor` and `runObservedPlaywright` are re-thrown untouched, so their own
 * messages — which name the offending paths — reach the operator verbatim rather than being reworded
 * by a second layer. This operation adds no catch-all of its own, and deliberately does not claim one:
 * exactly like `validate`, `approval record` and `attestation record`, a `--root` that does not resolve
 * surfaces as the raw filesystem error `RunWorkspace.open`'s `realpath` throws, which
 * `src/cli/program.ts` maps to `ABORTED_OR_INTERNAL`.
 */
export async function executeObservedPlaywright(input: ObservedPlaywrightExecutionInput): Promise<ObservedPlaywrightExecution> {
  const workspace = await RunWorkspace.open(input.root, input.runId);
  try {
    const artifacts = await workspace.readRegisteredArtifacts();
    const environment = environmentOf(artifacts);
    const { cases, artifactIdOf } = registeredCases(artifacts);

    const run = await runObservedPlaywright({
      projectRoot: input.root, specDir: input.specDir, args: input.args, environment,
      ...(input.execute === undefined ? {} : { execute: input.execute }),
    });
    // Before the report is interpreted at all: did the runner stay inside the tree the anchor covers?
    await assertExecutedSpecsAreAnchored(input.root, input.specDir, run.report);
    const mapped = mapObservedReport(run.report, cases);
    if (mapped.entries.length === 0) {
      throw new QaSkillsError(
        `The ${run.runner} run at ${run.anchor.commitSha} produced no spec bound to a registered test case, so there is no batch to register. `
        + `Tag each spec that should earn coverage credit with [qa:<testCaseId>/<revisionId>/<instanceId>@<surface>] in its test title, and register the matching test cases first.`
        + (mapped.excluded.length === 0 ? "" : `\nThe run reported these specs, none of which resolved:\n${describeExcluded(mapped.excluded)}`),
        "OBSERVED_RUN_NO_ENTRIES",
      );
    }

    const executionId = createEntityId();
    const evidenceId = createEntityId();
    const payload = `${JSON.stringify(sanitizeRunnerReport(run.report), null, 2)}\n`;
    const bundle = await workspace.registerEvidenceBundle({
      binaries: [{ filename: `${evidenceId}-sanitized-runner-report.json`, contents: Buffer.from(payload, "utf8"), mediaType: "application/json", captureType: "runner-report" }],
      // An observed execution binds no attempt, so this descriptor declares no `test-result`
      // relationship — `evidenceRule` asserts positively that it does not.
      relationships: [],
      provenance: "runtime",
      descriptor: (binaries) => {
        const binary = binaries[0];
        if (binary === undefined) throw new QaSkillsError("The runner-report evidence bundle registered no binary", "OBSERVED_RUN_EVIDENCE_FAILED");
        return {
          artifactType: "evidence", schemaVersion: "3.0.0", producerVersion: runtimeVersion,
          evidenceId, runId: workspace.runId,
          subject: { kind: "observed-execution", executionId },
          kind: "runner-report", capturedAt: run.finishedAt,
          sha256: binary.sha256, relativePath: binary.relativePath, mediaType: binary.mediaType,
          binaryArtifactIds: [binary.id],
          binaryArtifacts: [{ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType }],
          provenance: { captureType: "runner-report", runner: run.runner, runnerVersion: run.runnerVersion, exitCode: run.exitCode, capturedAt: run.finishedAt },
        };
      },
    });

    const caseArtifactIds = [...new Set(mapped.entries.flatMap((entry) => {
      const id = artifactIdOf(entry);
      return id === undefined ? [] : [id];
    }))];
    const batch = await workspace.registerArtifactValue({
      type: "test-result-batch",
      provenance: "runtime-observed",
      relationships: [bundle.descriptor.id, ...caseArtifactIds],
      value: {
        artifactType: "test-result-batch", schemaVersion: "3.0.0", producerVersion: runtimeVersion,
        executionId, runId: workspace.runId,
        commitSha: run.anchor.commitSha, specTreeSha256: run.anchor.specTreeSha256,
        startedAt: run.startedAt, finishedAt: run.finishedAt,
        // A PASSED entry must NOT declare evidence (`testResultBatchRule`): the plan's "evidence
        // attached only for failing cases", made checkable. One report substantiates the whole
        // execution, so every non-passing entry cites the same descriptor.
        entries: mapped.entries.map((entry) => entry.status === "PASSED" ? entry : { ...entry, evidenceArtifactIds: [bundle.descriptor.id] }),
      },
    });

    const runnerWorkingDir = runnerWorkingDirOf(run.report);
    return {
      executionId, batchArtifactId: batch.id, evidenceArtifactId: bundle.descriptor.id,
      commitSha: run.anchor.commitSha, specTreeSha256: run.anchor.specTreeSha256,
      exitCode: run.exitCode, entryCount: mapped.entries.length, excluded: mapped.excluded,
      ...(runnerWorkingDir === undefined ? {} : { runnerWorkingDir }),
    };
  } finally {
    await workspace.close();
  }
}
