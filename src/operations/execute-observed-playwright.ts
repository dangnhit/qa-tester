import { QaSkillsError } from "../core/errors.js";
import { createEntityId } from "../core/ids.js";
import { RunWorkspace, type RegisteredWorkspaceArtifact } from "../core/run-workspace.js";
import { runtimeVersion } from "../installer/manifest.js";
import { mapObservedReport, type ExcludedSpec, type ObservedEntry, type RegisteredCase } from "../observed/report-mapping.js";
import { runObservedPlaywright, type RunnerExecutor } from "../observed/run-playwright.js";
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

function describeExcluded(excluded: readonly ExcludedSpec[]): string {
  return excluded.map((spec) => `- ${JSON.stringify(spec.title)} (${spec.file}): ${spec.reason}`).join("\n");
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
 *   (CONTEXT.md:344). No entry names an `observedEngine` or a `viewport`, because no entry names the
 *   `browser` surface: `mapObservedReport` refuses one, and the schema forbids both fields elsewhere.
 * - The evidence carries `sanitizeRunnerReport`'s projection, not the report file the runner wrote. The
 *   descriptor's `sha256` is therefore the checksum of what was registered — the file on disk still
 *   holds `config.argv` and, for an ordinary web project, `config.webServer.env`, and registering it
 *   would put a resolved secret in an immutable artifact (CONTEXT.md:371).
 * - Evidence is attached to FAILING entries only, which is what `testResultBatchRule` enforces, and the
 *   batch declares the evidence artifact as a relationship as well as inside the entry, which is the
 *   other half of that rule.
 *
 * **Excluded is not refused.** A spec with no identity tag, or one naming a test case this run never
 * registered, is reported on the result rather than carried: the batch rule requires every entry to
 * match exactly one registered `test-case`, and an external suite legitimately holds specs this QA Run
 * never planned. A run in which NOTHING resolved is refused, because a batch with no entry cannot be
 * registered and a silent no-op would read as success.
 *
 * **Nothing is registered until everything maps.** The mapping runs before the first write, so a
 * refusal from it leaves a workspace with no half-written observation in it.
 *
 * Every failure is a `QaSkillsError`; the refusals that reach here from `runObservedPlaywright` and
 * `resolveGitAnchor` are re-thrown untouched, so their own messages — which name the offending paths —
 * reach the operator verbatim.
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

    return {
      executionId, batchArtifactId: batch.id, evidenceArtifactId: bundle.descriptor.id,
      commitSha: run.anchor.commitSha, specTreeSha256: run.anchor.specTreeSha256,
      exitCode: run.exitCode, entryCount: mapped.entries.length, excluded: mapped.excluded,
    };
  } finally {
    await workspace.close();
  }
}
