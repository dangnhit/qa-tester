import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { QaSkillsError } from "../core/errors.js";
import { isRealPathWithin } from "../core/fs.js";
import { RunWorkspace } from "../core/run-workspace.js";
import { isRecord } from "../core/values.js";
import { runtimeVersion } from "../installer/manifest.js";
import { renderJUnit } from "../reporting/projections/junit.js";
import { buildProjectionModel, type ProjectionArtifact } from "../reporting/projections/projection-model.js";
import { renderSarif } from "../reporting/projections/sarif.js";
import { projectionChecksum, renderSidecar } from "../reporting/projections/sidecar.js";

export type ProjectionFormat = "junit" | "sarif";

/** One registered payload this export could not read AS A SANITIZED RUNNER REPORT — it did not parse,
 *  or it parsed to something that is not an object. NOT a filesystem read failure: those are refused,
 *  not degraded (see `readRunnerReports`). Carried out of the operation rather than thrown; see
 *  {@link exportProjection} for why such a payload degrades the projection instead of failing it, and
 *  why it is nonetheless never swallowed. */
export type UnreadableRunnerReport = Readonly<{ artifactId: string; relativePath: string; reason: string }>;

export type ExportProjectionResult = Readonly<{
  format: ProjectionFormat;
  outPath: string;
  sidecarPath: string;
  projectionSha256: string;
  recommendation: string;
  reduced: boolean;
  unreadableRunnerReports: readonly UnreadableRunnerReport[];
}>;

const isFormat = (value: string): value is ProjectionFormat => value === "junit" || value === "sarif";

/**
 * Every registered sanitized runner report, named by the artifact that references it and the path its
 * bytes live at inside the run directory.
 *
 * This is the filter `specLocationsByEntryIdentity` used to apply to artifacts before the payloads moved
 * to this edge, and it is narrower than the one it replaces: an `evidence` artifact alone is not enough,
 * its descriptor must also declare `kind: "runner-report"` — the exact value
 * `execute-observed-playwright.ts:393` stamps on the one bundle that carries a sanitized report. A
 * screenshot descriptor is therefore never opened and parsed as JSON.
 *
 * Pure and exported so the selection can be tested without a workspace; the reading is the caller's.
 *
 * The `typeof relativePath === "string"` check is a type narrowing rather than a policy: every value
 * `readRegisteredArtifacts` exposes has already passed `validateArtifact` for its declared type
 * (`inspect-workspace-state.ts:332`), and `evidence.schema.json` requires `relativePath` as a non-empty
 * string. A descriptor that fails it cannot reach here from a registered workspace, so excluding it is
 * the honest answer — there is no file to name in a diagnostic.
 */
export function runnerReportSources(artifacts: readonly ProjectionArtifact[]): readonly Readonly<{ artifactId: string; relativePath: string }>[] {
  return artifacts.flatMap((artifact) => {
    if (artifact.record.type !== "evidence" || artifact.value.kind !== "runner-report") return [];
    const relativePath = artifact.value.relativePath;
    return typeof relativePath === "string" ? [{ artifactId: artifact.record.id, relativePath }] : [];
  });
}

/**
 * Reads and parses every registered sanitized runner report, so the pure reducer can join a lane-2 entry
 * to the spec file that produced it.
 *
 * **The checksums are already verified and are deliberately not verified again here.**
 * `inspect-workspace-state.ts:320` recomputes a sha256 from the file's actual bytes and compares it to
 * the manifest's declared `record.sha256` for EVERY record including binaries — that call sits above the
 * `record.mediaType !== undefined` early return at line 324 precisely so a tampered binary cannot load
 * as valid, and its own comment says so. `readRegisteredArtifacts` throws `ARTIFACT_BINDING` on the
 * first resulting diagnostic, so by the time this function runs the bytes on disk have already been
 * proven to be the registered ones. A second verification path here could only ever agree — or disagree
 * and be wrong, which is the asymmetry the `VALID_ARTIFACTS` incident is about.
 *
 * **Exactly two failures are degraded, and neither is a failure to READ.** `workspace.resolve`
 * (`assertRealpathWithin`) and `readFile` are deliberately left uncaught. A descriptor pointing outside
 * the run directory is a containment violation of the same class as `PATH_ESCAPE`/`SYMLINK_ESCAPE`; and
 * a file that cannot be read at all has just been read and hashed successfully by
 * `inspectWorkspaceState` moments earlier in this same call, so a failure here means the workspace is
 * being mutated underneath the export — the ground shifting, not a malformed payload. Turning either
 * into an annotation would be precisely the swallow this operation must not perform. What IS degraded
 * is a payload that arrives intact and does not say what a sanitized report says: unparseable, or
 * parsing to something that is not an object.
 *
 * **The reason never quotes the payload.** MEASURED on this runtime, not assumed: V8's own
 * `SyntaxError` text embeds the offending input, truncated to ten characters and an ellipsis for a long
 * one (`Unexpected token 'p', "password12"... is not valid JSON`) and VERBATIM for a short one
 * (`Unexpected token 's', "secret" is not valid JSON`). That string would leave the artifact system for
 * a CI log — the one direction CONTEXT.md:371 controls ("never resolved secret values"). A payload that
 * failed to parse is exactly the one whose contents nothing has vouched for, so the two reasons below
 * are fixed strings; the artifact id and relative path are what let an operator find the file itself.
 */
async function readRunnerReports(
  workspace: RunWorkspace,
  artifacts: readonly ProjectionArtifact[],
): Promise<Readonly<{ reports: readonly Readonly<Record<string, unknown>>[]; unreadable: readonly UnreadableRunnerReport[] }>> {
  const reports: Readonly<Record<string, unknown>>[] = [];
  const unreadable: UnreadableRunnerReport[] = [];
  for (const source of runnerReportSources(artifacts)) {
    const text = await readFile(await workspace.resolve(source.relativePath), "utf8");
    const degrade = (reason: string): void => { unreadable.push({ artifactId: source.artifactId, relativePath: source.relativePath, reason }); };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      degrade("payload is not valid JSON");
      continue;
    }
    if (isRecord(parsed)) reports.push(parsed);
    else degrade("payload is not a JSON object");
  }
  return { reports, unreadable };
}

/**
 * Refuses before anything is written unless every output path can be RESOLVED to a location outside the
 * results root. What that does and does not cover is set out below; the short version is that it
 * resolves symlinks and does not see hard links.
 *
 * **NOT COVERED: a HARD LINK at either output path. Confirmed by execution, and open.** `realpath` has
 * no target to follow for a hard link — it answers with the path it was given — so `isRealPathWithin`
 * returns `false` for a path whose INODE is a registered artifact inside `qa-results/`, this guard waves
 * it through, and `writeFile`'s `O_TRUNC` overwrites that inode in place. The consequence is the
 * symlink attack's exactly: the victim run is `CHECKSUM_MISMATCH` forever and the export exits 0. The
 * extra precondition is same-filesystem placement (and, on Linux with the default
 * `fs.protected_hardlinks=1`, permission to link the target; unrestricted on macOS). This is NOT
 * TOCTOU-shaped and `O_NOFOLLOW` does not address it — `O_NOFOLLOW` refuses a symlink and cannot see a
 * second name for an inode. The fix is to ask the containment question AT OPEN TIME, against the file
 * descriptor about to be written: `O_NOFOLLOW` plus an `fstat` rejecting `nlink > 1`. Filed as its own
 * task; the doc says so here rather than claiming a coverage this function does not have.
 *
 * **ALSO NOT COVERED: the window between this check and the writes.** Every path is resolved here, at
 * the first statement of the operation, and the writes happen after `readRegisteredArtifacts()` and
 * every runner-report read — the slowest stretch of the operation. A symlink planted at an output path
 * during that window is followed. Checking each path immediately before its own write would narrow the
 * window but reopen a worse hole: a projection written and then a refused sidecar leaves bytes on disk
 * that nothing vouches for. Correctness ordering and TOCTOU exposure pull in opposite directions here,
 * and only the open-time check above resolves both — which is the second reason that follow-up is
 * framed as "check at open time" rather than "add `O_NOFOLLOW`".
 *
 * **Every output, not just `--out`.** The sidecar's path is DERIVED from the projection's by
 * concatenation, so a guard on `--out` alone says nothing about it — and being derived is what makes it
 * the easier of the two to attack: it needs no influence over the caller's argument at all. A symlink
 * planted at `<out>.provenance.json` pointing into a run would be followed by `writeFile` (which opens
 * `O_CREAT|O_TRUNC` with no `O_NOFOLLOW`), overwriting a registered artifact and leaving that run
 * `CHECKSUM_MISMATCH` forever, or creating one and leaving it `ORPHAN_FILE`.
 *
 * **Every output before ANY write**, which is a stronger claim than checking each just before its own
 * write. A projection written and then a refused sidecar would leave a projection on disk that nothing
 * vouches for — the exact state the sidecar exists to make impossible, reached by way of the check meant
 * to protect it.
 *
 * **Scoped to the whole results root** (`dirname(workspace.path)`, already realpath'd by
 * `RunWorkspace.open`): a file landing in ANY run's `inputs/` or `evidence/` invalidates THAT run, not
 * merely the one being projected.
 *
 * **A destination that cannot be resolved is refused, not assumed innocent.** `isRealPathWithin` throws
 * rather than answering when the path is a dangling symlink or a symlink loop. Every such failure
 * becomes a refusal here: the guard's job is to PROVE the write lands outside the runs, and "I could not
 * work out where this write goes" is not a proof. Failing closed costs an operator whose `--out` is a
 * link to a not-yet-created file OUTSIDE `qa-results/` — that used to succeed, and now refuses (the
 * availability cost is stated in the task report). Failing open would cost a run.
 */
async function assertOutputsAreOutsideTheRuns(closedRuns: string, outputs: readonly string[]): Promise<void> {
  for (const candidate of outputs) {
    let inside: boolean;
    try {
      // `isRealPathWithin` rather than a comparison written here: it resolves symlinks at the LEAF as
      // well as in the parents, so an output that is itself a link into a run is refused rather than
      // followed. A `realpath(dirname(candidate))` written locally would miss precisely that, and would
      // re-derive a decision `core/fs.ts` owns — which is what `fa6c60c` records the cost of.
      inside = await isRealPathWithin(closedRuns, candidate);
    } catch {
      throw new QaSkillsError(`Refusing to write ${candidate}: its destination could not be resolved, so it cannot be shown to lie outside ${closedRuns}. A symlink whose target does not exist, or a symlink loop, is the usual cause.`, "INVALID_ARTIFACT");
    }
    if (inside) {
      throw new QaSkillsError(`Refusing to write ${candidate} inside ${closedRuns}: a run workspace is closed and checksummed, and a file written into one either invalidates a registered artifact or orphans the run. A projection and its sidecar belong beside the runs, never inside them.`, "INVALID_ARTIFACT");
    }
  }
}

/**
 * Projects a finalized run's release gate into a CI-readable file, beside a provenance sidecar.
 *
 * **No second gate derivation.** `readRegisteredArtifacts` re-inspects the whole workspace and throws
 * `ARTIFACT_BINDING` on the first diagnostic (`run-workspace.ts:448-450`); that IS the verification, and
 * the gate this projects is the persisted one, carried verbatim. Re-deriving it here to compare against
 * the persisted value is exactly the asymmetry the `VALID_ARTIFACTS` incident records: two derivation
 * paths that can disagree leave a persisted gate permanently flagged on every later read.
 *
 * **An unreadable runner report degrades the projection; it never fails it.** A spec location is an
 * annotation on a result that already exists, never a gate on whether it exists — `spec-locations.ts`
 * settles that for a malformed tag, and a malformed FILE is the same question one level out. Refusing
 * the whole export would deny a CI consumer the gate verdict it asked for over an annotation, and the
 * bytes that would have carried it are the one input here that no schema validates. But it is not
 * swallowed either: every unreadable payload is named — artifact id, path, and what was wrong with it —
 * on `unreadableRunnerReports`, which the CLI prints on stdout AND flags on stderr. Silence is what the
 * `VALID_ARTIFACTS` incident cost; a non-fatal, named, machine-readable degradation is not silence.
 * `readRunnerReports` below draws the line between what degrades and what still refuses.
 *
 * **Nothing is written inside `qa-results/`.** A finalized run is closed, and an unregistered file under
 * any run's `inputs/` or `evidence/` directory would raise `ORPHAN_FILE`
 * (`inspect-workspace-state.ts:542`) on every later read of THAT run — an export that bricked a run,
 * whether or not it is the one being projected. Overwriting a registered file is worse still: that run
 * is `CHECKSUM_MISMATCH` forever. So BOTH of this operation's outputs — the projection and the sidecar
 * derived from its name — are checked against the whole results root, symlinks resolved, and BOTH are
 * checked before EITHER is written. Two routes are NOT covered and are named where the check lives, not
 * here: a hard link at an output path, and the window between the check and the writes. See
 * `assertOutputsAreOutsideTheRuns` for both, and read this heading as what the guard enforces rather
 * than as an unconditional guarantee.
 */
export async function exportProjection(options: Readonly<{ root: string; runId: string; format: string; outPath: string }>): Promise<ExportProjectionResult> {
  if (!isFormat(options.format)) throw new QaSkillsError(`Unsupported projection format ${options.format}: use junit or sarif`, "INVALID_ARTIFACT");
  const outPath = resolve(options.outPath);
  const sidecarPath = `${outPath}.provenance.json`;
  const workspace = await RunWorkspace.open(options.root, options.runId);
  try {
    await assertOutputsAreOutsideTheRuns(dirname(workspace.path), [outPath, sidecarPath]);
    const artifacts = await workspace.readRegisteredArtifacts();
    const { reports, unreadable } = await readRunnerReports(workspace, artifacts);
    // `resolve(options.root)`, not the realpath'd `dirname(dirname(workspace.path))`, and the choice is
    // deliberate. This value is what a joined spec location is expressed RELATIVE TO, so it must be the
    // same directory a SARIF consumer resolves `artifactLocation.uri` against — the checkout the
    // operator named, which in `README.md`'s pipeline is `--root .`. It is also the spelling most likely
    // to match the `config.rootDir` recorded in a sanitized runner report, because Playwright resolves
    // its config path rather than realpath'ing it. Resolved but not realpath'd, both sides are then
    // compared the way they were produced; where the two spellings genuinely differ,
    // `spec-locations.ts` emits no location rather than a wrong one.
    const model = buildProjectionModel({ runId: workspace.runId, producerVersion: runtimeVersion, generatedAt: new Date().toISOString(), runRoot: resolve(options.root), artifacts, runnerReports: reports });
    const rendered = Buffer.from(options.format === "junit" ? renderJUnit(model) : renderSarif(model), "utf8");
    // The projection is written first and the sidecar second, so a sidecar never describes bytes that
    // do not exist. The reverse order would leave a provenance claim about a missing file.
    await writeFile(outPath, rendered);
    await writeFile(sidecarPath, renderSidecar(model, options.format, rendered), "utf8");
    return {
      format: options.format, outPath, sidecarPath,
      projectionSha256: projectionChecksum(rendered),
      recommendation: model.gate.recommendation, reduced: model.reduced,
      unreadableRunnerReports: unreadable,
    };
  } finally {
    await workspace.close();
  }
}
