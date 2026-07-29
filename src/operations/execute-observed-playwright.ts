import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { QaSkillsError } from "../core/errors.js";
import { assertRealpathWithin } from "../core/fs.js";
import { resolveGitAnchor, type GitAnchor } from "../core/git-anchor.js";
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
 * **Re-resolves the git anchor after the runner exits and refuses if it moved.**
 *
 * `runObservedPlaywright` resolves the anchor before it spawns, and nothing between that resolution and
 * the process's exit re-reads the spec tree. Meanwhile the runner loads code the anchor does not cover
 * and cannot cover — the project's own `playwright.config`, a `--config` passed after `--`,
 * `globalSetup`/`globalTeardown`, fixtures, every helper any of them imports — and that code runs with
 * write access to the working tree. A `globalTeardown` that writes into the anchored directory, or a
 * config-level `process.on("exit")` hook that does, changes the bytes on disk while `specTreeSha256`
 * still records the bytes that were there before. The batch would then carry an anchor describing a tree
 * that is not the tree standing at the end of the run.
 *
 * So the anchor is resolved a second time and compared. Two shapes of failure, one refusal:
 *
 * - **The second resolution refuses.** The likelier shape by far, because the ordinary mutation —
 *   writing a file into the spec directory — leaves the tree dirty, and `resolveGitAnchor` refuses a
 *   dirty tree outright rather than returning a different digest. Its refusal is quoted, but its code is
 *   NOT reused: `SPEC_TREE_DIRTY` before the run is an external condition a person clears by committing
 *   or reverting, and it exits `BLOCKED` for exactly that reason. The same words after the run mean the
 *   observed process wrote into the tree that certifies it, which is a containment violation and not the
 *   operator's housekeeping.
 * - **The second resolution succeeds with different values.** Reachable when the run leaves the tree
 *   clean again — a teardown that commits its own change is the honest example. Nothing else on this
 *   path can see that case at all.
 *
 * **What this does not catch, stated because the point of the check is not to overclaim.** It compares
 * two snapshots and sees only a difference that survives to the second one: code that edits a spec,
 * runs it, and restores the original bytes before the process exits leaves both anchors equal. Nor does
 * it say anything about the unanchored code itself, which ran either way. What it closes is the one
 * half that is closable — the anchor can no longer certify a tree that visibly changed underneath it.
 * The other half is {@link assertExecutedSpecsAreAnchored}'s to disclose.
 */
async function assertAnchorSurvivedTheRun(root: string, specDir: string, before: GitAnchor): Promise<void> {
  const preamble = `The spec tree at ${specDir} no longer matches the git anchor this run recorded before the ${runnerLabel} runner started`;
  const consequence = `A ${runnerLabel} run loads code the anchor does not cover — your playwright.config, a --config after --, globalSetup/globalTeardown and every helper they import — and that code can write to the spec tree while the run is in progress. `
    + `A batch's commitSha and specTreeSha256 are immutable once written, so an anchor the QA Runtime can no longer stand behind is refused rather than recorded. Nothing was registered.`;

  let after: GitAnchor;
  try {
    after = await resolveGitAnchor({ projectRoot: root, specDir });
  } catch (error: unknown) {
    throw new QaSkillsError(
      `${preamble}: it resolved cleanly before the run and cannot be resolved at all now. ${consequence}\nThe second resolution refused with:\n`
      + (error instanceof Error ? error.message : String(error)),
      "OBSERVED_RUN_ANCHOR_CHANGED",
    );
  }

  // Both values are compared, and the asymmetry between them is disclosed rather than left to look
  // like two equal checks. `commitSha` moving alone is reachable and tested — a run that commits
  // anything OUTSIDE `--spec-dir` does it. `specTreeSha256` moving alone is NOT reachable: this second
  // resolution only returns at all when the tree is clean, clean means the tracked bytes under
  // `--spec-dir` equal the ones at HEAD, so the digest is a function of the commit and cannot move
  // while the commit stands still. The digest comparison is therefore defence in depth, not an
  // independently triggerable refusal, and a mutation deleting it survives every reachable state.
  // It stays: it is the value the batch actually records, and it is the half that keeps holding if
  // `resolveGitAnchor`'s dirty check is ever scoped more narrowly than the digest.
  const moved = [
    ...(after.commitSha === before.commitSha ? [] : [`commitSha ${before.commitSha} -> ${after.commitSha}`]),
    ...(after.specTreeSha256 === before.specTreeSha256 ? [] : [`specTreeSha256 ${before.specTreeSha256} -> ${after.specTreeSha256}`]),
  ];
  if (moved.length === 0) return;
  throw new QaSkillsError(`${preamble}, and the tree is clean at the new value, so nothing else would have noticed:\n${moved.map((change) => `- ${change}`).join("\n")}\n${consequence}`, "OBSERVED_RUN_ANCHOR_CHANGED");
}

/**
 * **Refuses an execution whose report names any spec file the git anchor does not describe.**
 *
 * The anchor is computed over `--spec-dir` alone, but nothing constrains the runner to that directory:
 * `runObservedPlaywright` refuses only `--reporter` and `--output`, so a caller's `--config` reaches
 * the runner untouched, and an ordinary project's `playwright.config` may simply declare a `testDir`
 * broader than `--spec-dir`. Either way the batch would record a `commitSha` and a `specTreeSha256`
 * describing a tree that is not the tree that ran, and — since the identity tag is trusted precisely
 * because it lives inside the anchored, reviewed tree — a spec outside it could earn coverage credit
 * having been reviewed by nobody. That is CONTEXT.md:344-345 with no other refusal in the way.
 *
 * **Every spec file the report names is checked, and one failure refuses the whole execution.** Not
 * excluding the offenders: excluding would still register a batch whose `specTreeSha256` claims to
 * describe the tree that ran while something outside it also ran. The anchor is a statement about the
 * execution as a unit, so one unanchored spec falsifies it for all of them — and nothing has been
 * registered at this point, so refusing costs no partial state.
 *
 * **BOTH SIDES OF THIS CHECK COME FROM THE OBSERVED PROCESS, AND THAT BOUND IS NOT CLOSABLE HERE.** The
 * file list is each `spec.file` in the report's nested `suites` tree, and the directory those names are
 * resolved against is the report's own `config.rootDir`. `runObservedPlaywright` hands the runner a
 * `PLAYWRIGHT_JSON_OUTPUT_FILE` path and reads back whatever is at that path once the process exits; it
 * applies no signature, no nonce and no integrity check, because there is nothing to check one against
 * — the reporter that writes that file is a module loaded inside the process being observed. Everything
 * else loaded inside that process is unanchored too: the project's `playwright.config`, a `--config`
 * after `--`, `globalSetup`/`globalTeardown`, fixtures, and every helper any of them imports. A config
 * carrying `process.on("exit", …)` that rewrites the report file can therefore hand this check a report
 * in which a genuinely failing anchored spec is described as having passed, under a `config.rootDir`
 * inside the anchored directory — and this check passes it, because everything it reads is what that
 * hook wrote.
 *
 * **So state what is enforced, in the terms it is actually enforced in.** This refuses an execution
 * whose *report* places a spec outside `--spec-dir`. That is worth having and is not a formality: it is
 * what stops an ordinary project whose `testDir` is broader than `--spec-dir` from crediting files
 * `specTreeSha256` never hashed, and what stops a caller-supplied `--config` aimed at an unreviewed
 * tree from doing it deliberately — the accident, and the adversary that does not go to the trouble of
 * forging a report. It is not a proof about the execution. The anchor proves which bytes a human
 * committed and merged, and {@link assertAnchorSurvivedTheRun} proves those bytes were still standing
 * when the runner exited; no check anywhere on this path proves that those bytes, and only those,
 * produced the recorded result. That is the shape of observing an external runner rather than
 * interpreting it, which is why it is disclosed here rather than implied away.
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
 * **What `runtime-observed` claims here, and what it does not — stated so no reader infers wider.** The
 * runtime resolved the runner binary itself, pinned the reporter, spawned the process, captured its exit
 * status and output, and re-checked the anchor afterwards. That is the provenance claim, and it is the
 * whole of what separates lane 2 from a report file an agent hands over. The *results* are then read out
 * of the JSON report that same process wrote, and the code that process loads is outside the anchor and
 * cannot be brought inside it: `playwright.config`, a `--config` after `--`,
 * `globalSetup`/`globalTeardown`, fixtures and every helper any of them imports all live outside
 * `--spec-dir`, are absent from `specTreeSha256`, and run with the runtime's trust. So what a batch
 * registered here binds is a committed, human-merged spec tree — proven unchanged across the run — to an
 * execution this runtime started and whose exit it saw. It does not certify that those anchored bytes,
 * and only those, produced each recorded status. Report authorship is not closable while the runtime
 * observes an external runner rather than interpreting it, which is exactly why it is written down
 * instead of being left to be discovered. {@link assertExecutedSpecsAreAnchored} sets out the mechanics.
 *
 * **What each artifact says, and what it deliberately does not:**
 *
 * - The batch's `commitSha` and `specTreeSha256` come from `resolveGitAnchor`, which ran BEFORE the
 *   process started; a spec tree that differs from its commit produces no observed execution at all
 *   (CONTEXT.md:344). The same anchor is resolved again AFTER the runner exits and refused if it moved
 *   ({@link assertAnchorSurvivedTheRun}), so a run that rewrote the tree certifying it registers
 *   nothing. And the report's account of what it ran is checked against what the anchor covers
 *   ({@link assertExecutedSpecsAreAnchored}), without which a caller's `--config`, or an ordinary
 *   project whose `testDir` is broader than `--spec-dir`, would credit coverage from files the checksum
 *   never hashed. No entry names an `observedEngine` or a `viewport`, because no entry names the
 *   `browser` surface: `mapObservedReport` refuses one, and the schema forbids both fields elsewhere.
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
    // Two containment questions, in this order, both before the report is interpreted and both before
    // anything is written. First: does the anchor still describe the tree on disk? It goes first
    // because it is answered from git rather than from the report — a pass from the second check is a
    // statement about a directory whose contents the anchor may by then no longer describe, so the
    // weaker evidence must not be what the operator is handed as the cause.
    await assertAnchorSurvivedTheRun(input.root, input.specDir, run.anchor);
    // Second: does the report place every spec it names inside that same tree?
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
