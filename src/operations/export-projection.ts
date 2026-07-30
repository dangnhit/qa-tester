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
 * whether or not it is the one being projected. So an `--out` resolving anywhere inside the results
 * root is refused rather than trusted to be harmless, symlinks included.
 */
export async function exportProjection(options: Readonly<{ root: string; runId: string; format: string; outPath: string }>): Promise<ExportProjectionResult> {
  if (!isFormat(options.format)) throw new QaSkillsError(`Unsupported projection format ${options.format}: use junit or sarif`, "INVALID_ARTIFACT");
  const outPath = resolve(options.outPath);
  const sidecarPath = `${outPath}.provenance.json`;
  const workspace = await RunWorkspace.open(options.root, options.runId);
  try {
    // Scoped to the whole `qa-results/` root, not just the run being exported. A projection written
    // into ANY run's `inputs/` or `evidence/` raises `ORPHAN_FILE` for that run on every later read
    // (`inspect-workspace-state.ts:542`), so the guard's own justification argues for the wider scope;
    // and the root is not something this operation has to go looking for — `dirname(workspace.path)`
    // is it, already realpath'd by `RunWorkspace.open`.
    //
    // `isRealPathWithin` rather than a comparison written here: it resolves symlinks at the LEAF as
    // well as in the parents, so `--out /tmp/junit.xml` where that file is a symlink into a run's
    // `inputs/` is refused rather than followed. A `realpath(dirname(outPath))` written locally would
    // miss precisely that, and would also re-derive a decision `core/fs.ts` owns.
    const closedRuns = dirname(workspace.path);
    if (await isRealPathWithin(closedRuns, outPath)) {
      throw new QaSkillsError(`Refusing to write ${outPath} inside ${closedRuns}: a run workspace is closed and checksummed, and a projection written into one would be an unregistered file that invalidates it. A projection belongs beside the run, never inside it.`, "INVALID_ARTIFACT");
    }
    const artifacts = await workspace.readRegisteredArtifacts();
    const { reports, unreadable } = await readRunnerReports(workspace, artifacts);
    const model = buildProjectionModel({ runId: workspace.runId, producerVersion: runtimeVersion, generatedAt: new Date().toISOString(), artifacts, runnerReports: reports });
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
