import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, rm, type FileHandle } from "node:fs/promises";
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
  /**
   * How many observed failures this projection reports without naming a source file — SARIF ONLY, and
   * ABSENT for JUnit rather than `0`.
   *
   * The absence is the honest answer, not a gap: `renderJUnit` reads `location` nowhere at all, so a `0`
   * there would read as "every failure was placed" when the truth is that a JUnit projection never places
   * any of them. Present and `0` means the question was asked and every observed failure was placed.
   *
   * Non-zero is a degradation of the same class as `unreadableRunnerReports` and is deliberately a
   * SEPARATE signal from it: the payload behind an unplaced result may have read perfectly, and the join
   * still failed — a `config.rootDir` the run root does not contain, a spec whose identity tag two
   * reports disagree about, or a path no URI can spell. `sarif.ts` says why the reasons are not
   * distinguished from one another.
   */
  observedResultsWithoutLocation?: number;
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
 * results root. This is the PATH half of the containment question, and it is kept alongside the
 * descriptor half in `assertOutputsHaveOneName` because neither subsumes the other:
 *
 * - Only this one sees an ordinary, link-free `--out` that simply points inside `qa-results/`. That path
 *   opens to a perfectly innocent descriptor with one name; an `fstat` has nothing to object to, because
 *   a descriptor knows nothing about where its path was.
 * - Only the descriptor half sees a HARD LINK. `realpath` has no target to follow for a second name — it
 *   answers with the path it was given — so this function correctly reports `false` for a path whose
 *   INODE is a registered artifact. That answer is about the NAME, and a write lands on the inode.
 *
 * Both run, in that order, and the ordering is deliberate: this one produces the specific refusals an
 * operator can act on (`inside <results root>`, `destination could not be resolved`), so it gets to
 * speak first about a path it can already condemn.
 *
 * **Every output, not just `--out`.** The sidecar's path is DERIVED from the projection's by
 * concatenation, so a guard on `--out` alone says nothing about it — and being derived is what makes it
 * the easier of the two to attack: it needs no influence over the caller's argument at all. A symlink
 * planted at `<out>.provenance.json` pointing into a run was once followed by the `writeFile` this
 * operation used (`O_CREAT|O_TRUNC`, no `O_NOFOLLOW`), overwriting a registered artifact and leaving
 * that run `CHECKSUM_MISMATCH` forever, or creating one and leaving it `ORPHAN_FILE`.
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

/** One output this operation holds open for the whole of its run, and whether the open CREATED it —
 *  which is the only thing that entitles the operation to remove it again (see `releaseOutputs`). */
type OpenOutput = Readonly<{ path: string; handle: FileHandle; created: boolean }>;

/**
 * `node -p "require('fs').constants.O_NOFOLLOW"` answers `256` on darwin (Node 25.8.0) — MEASURED. The
 * constant is documented as unavailable on Windows, where no such open flag exists, and that half is NOT
 * measured here: this repo has no Windows machine, and `tests/operations` is not in the Windows CI job.
 * `?? 0` therefore states a platform truth rather than guarding a type, and the code below is written so
 * an absent constant degrades rather than producing a malformed flag word.
 *
 * **What Windows loses is narrower than it first looks, and this too was measured** — by forcing this
 * constant to `0` and re-running the suite. Only ONE test goes red: the refusal of an `--out` that is
 * ALREADY a symlink when the operation opens it. The test that plants a symlink DURING the read stretch
 * still passes, because `O_CREAT|O_EXCL` had already created the file and pinned its inode; a name
 * changed afterwards cannot reach a descriptor. So the TOCTOU window is closed on every platform by the
 * open, not by this flag.
 *
 * What this flag adds on POSIX is the guarantee that no name is resolved twice: without it, a path that
 * is a symlink at open time yields the TARGET's descriptor, and a swap between the path guard's
 * `realpath` and that open would redirect the write. Windows keeps the path guard (which already refuses
 * a symlink resolving INTO a run), and it still ASKS the `nlink` question below — but asking is not
 * answering: nothing here has measured what NTFS reports, and on exFAT, FAT32 and many network shares
 * `nlink` is simply 1 because the filesystem has no hard links to count.
 */
const openNoFollow: number = fsConstants.O_NOFOLLOW ?? 0;

/**
 * `O_NONBLOCK` (4 on darwin, measured; likewise absent on Windows) changes nothing for a regular file —
 * a 300,000-byte write through a descriptor carrying it lands in full, measured — and everything for a
 * FIFO: opening one for WRITING blocks until a reader appears, indefinitely.
 *
 * That block matters because this operation opens at the TOP. An attacker who can create a name at
 * either output path — the same capability the hard-link and symlink guards exist to defend against, and
 * `<out>.provenance.json` needs no influence over the caller's argument at all — could otherwise hang
 * `qa-skill export` forever, before any diagnostic is produced and where `process.exit` cannot help.
 * With this flag the open answers `ENXIO` immediately (0 ms, measured) and `openOutput` turns that into
 * the same shape refusal a FIFO WITH a reader gets from the `isFile` check.
 */
const openNonBlocking: number = fsConstants.O_NONBLOCK ?? 0;

/**
 * Opens one output for writing WITHOUT `O_TRUNC`, and reports whether it had to create it.
 *
 * **No `O_TRUNC`, and that is the whole ordering constraint.** `O_TRUNC` empties the file AT OPEN, which
 * is before any `fstat` could refuse it — a refused write would then leave the victim's bytes already
 * gone, and the guard would have done the attacker's work. The truncation is deferred to `writeOpened`,
 * after both descriptors are proven, so a refusal anywhere leaves every existing byte untouched.
 *
 * **`O_CREAT|O_EXCL` first, plain open second, and the distinction is the residue policy.** The two-step
 * is not a race workaround; it is how this operation learns whether the file is one it may clean up.
 * `O_EXCL` also refuses to follow a symlink by POSIX rule, so a linked path reaches the second open,
 * where `O_NOFOLLOW` turns it into `ELOOP` and a refusal that names what happened. `O_NOFOLLOW` on the
 * FIRST open is therefore redundant on any POSIX system — it is kept because a security property should
 * not rest on one platform honouring one clause of a specification, and it costs nothing.
 *
 * **A non-regular `--out` is refused by SHAPE, here, not diagnosed later.** Neither `O_NOFOLLOW` nor
 * `nlink` sees a FIFO or a device node — measured: a FIFO with a reader opens, `isFile()` false,
 * `nlink` 1 — so both containment guards wave it through. What happens next is worse than an error, and
 * was measured by removing this check: `truncate(0)` no-ops silently, `writeFile` streams the whole
 * projection into the pipe, the sidecar lands on disk as an ordinary file, and the export exits 0
 * CERTIFYING bytes that no longer exist anywhere a reader can check them. A non-seekable destination is
 * not supported at all — the sidecar is a SECOND file derived from this one's name, and a stream has no
 * second file. Asked at open because the shape of an already-open descriptor cannot change afterwards.
 *
 * The availability cost is real and deliberate: an operator whose `--out` is a symlink to a file
 * elsewhere OUTSIDE `qa-results/` used to be written through, and is now refused. That is what buys the
 * property everything else here depends on — the descriptor proven is the descriptor written, with no
 * name resolved a second time in between.
 */
async function openOutput(path: string): Promise<OpenOutput> {
  const creating = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | openNoFollow | openNonBlocking;
  let opened: Readonly<{ handle: FileHandle; created: boolean }>;
  try {
    opened = { handle: await open(path, creating, 0o666), created: true };
  } catch (error: unknown) {
    // Passed through rather than falling on to the second open, which would answer a DIFFERENT question
    // about the same path: a read-only parent directory yields `EACCES` here and `ENOENT` there
    // (measured), and only the first is the true diagnosis.
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    opened = { handle: await openExistingOutput(path), created: false };
  }
  try {
    const shape = await opened.handle.stat();
    if (!shape.isFile()) {
      throw new QaSkillsError(`Refusing to write ${path}: it is not a regular file. A projection is written beside a provenance sidecar derived from its name, so a FIFO, socket or device node cannot be an export destination — there is no second file to put the sidecar in, and a stream cannot be truncated or written at an offset. Export to an ordinary file.`, "INVALID_ARTIFACT");
    }
  } catch (error: unknown) {
    // The refusal above, or a failed `fstat`, is what the caller must see; a failure to close a handle
    // nobody will use cannot be allowed to replace it.
    try { await opened.handle.close(); } catch { /* Superseded by the error being rethrown. */ }
    throw error;
  }
  return { path, handle: opened.handle, created: opened.created };
}

/** The second open, for a path that already exists. Two errno cases become typed refusals because their
 *  raw form names a mechanism rather than a decision the operator can act on; everything else is passed
 *  through as the filesystem reported it. */
async function openExistingOutput(path: string): Promise<FileHandle> {
  try {
    return await open(path, fsConstants.O_WRONLY | openNoFollow | openNonBlocking);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new QaSkillsError(`Refusing to write ${path}: it is a symbolic link, and this export writes only through a path it opened itself. Following it would mean the destination that was proved and the destination that is written were resolved at two different moments. Name the target directly.`, "INVALID_ARTIFACT");
    }
    if (error instanceof Error && "code" in error && error.code === "ENXIO") {
      throw new QaSkillsError(`Refusing to write ${path}: it is not a regular file — opening it did not reach a writable file at all, which for an output path means a FIFO with no reader, or a device with nothing behind it. Export to an ordinary file.`, "INVALID_ARTIFACT");
    }
    throw error;
  }
}

/** Both outputs, or neither: if the second cannot be opened, the first is released — closed, and removed
 *  if this call created it — before the failure propagates. Returned as a tuple because this operation
 *  has exactly two outputs and the property being defended is about exactly those two. */
async function openOutputs(projectionPath: string, sidecarPath: string): Promise<readonly [OpenOutput, OpenOutput]> {
  const projection = await openOutput(projectionPath);
  try {
    return [projection, await openOutput(sidecarPath)];
  } catch (error: unknown) {
    await releaseOutputs([projection], false);
    throw error;
  }
}

/**
 * Refuses unless every open descriptor is the ONLY name for its inode.
 *
 * A hard link is not a redirection that something could resolve; it IS the file, under a second name, so
 * `realpath` has nothing to follow and the path guard above answers — correctly, about the name — that
 * the destination lies outside the runs. Ask the same question of the DESCRIPTOR and the answer changes:
 * `nlink > 1` means these bytes are reachable by another name, and one of those names may be a
 * registered artifact inside a closed run. Refusing every second-named output is the conservative
 * reading, because a descriptor cannot say WHERE its other names are.
 *
 * **Asked of all outputs immediately before the first write, not at open.** Opening happens at the top
 * of the operation, ahead of the whole read stretch; asking there would age the answer by exactly the
 * window this design exists to close. Asking here keeps Phase 8a's ordering intact — both outputs proven
 * before either is written — while making the answer as fresh as the descriptors allow. Nothing can
 * substitute a different file in between: a descriptor names an inode, and renaming or replacing the
 * PATH after this point cannot reach it. What remains is an attacker who links a name onto a file this
 * operation itself just created; reaching that requires write access to a run directory, which already
 * permits creating an orphan outright.
 *
 * The availability cost: an operator who deliberately hard-links their `--out` to somewhere else is
 * refused. There is no way to tell that apart from the attack, because the inode is the same object in
 * both stories.
 *
 * **The question is asked on every platform; the ANSWER is only as good as the filesystem.** `nlink` is
 * measured here on APFS only. Nothing has measured NTFS, and exFAT, FAT32 and many network mounts have
 * no hard links to count and report `1` unconditionally — where they are mounted, this refusal cannot
 * fire and the path guard above is the whole of the containment story.
 */
async function assertOutputsHaveOneName(outputs: readonly OpenOutput[]): Promise<void> {
  for (const output of outputs) {
    const { nlink } = await output.handle.stat();
    if (nlink > 1) {
      throw new QaSkillsError(`Refusing to write ${output.path}: its bytes already answer to ${nlink} names (a hard link), so writing here may overwrite a registered artifact reached by one of the others and leave that run CHECKSUM_MISMATCH forever. No path check can see this, because a second name for an inode is not a redirection — it is the file. Export to a path this command can create for itself.`, "INVALID_ARTIFACT");
    }
  }
}

/**
 * Truncates, then writes EVERY byte or throws — the `O_TRUNC` that `openOutput` deliberately withheld,
 * applied once both outputs have been proven.
 *
 * **`handle.writeFile`, not `handle.write`, and the difference is not stylistic.** A single
 * `handle.write` issues one `pwrite` and REPORTS a short count without throwing: measured, a
 * 100,000-byte buffer under `ulimit -f 20` resolves with `bytesWritten = 20480`. POSIX permits that at a
 * resource limit and at `ENOSPC`, and network filesystems do it in practice. Ignoring the count is how a
 * truncated projection gets a sidecar certifying bytes it does not contain — silent corruption, exit 0,
 * in the operation whose entire purpose is integrity. `handle.writeFile` is the same loop `fs.writeFile`
 * ran before this operation moved to descriptors, so this restores that contract rather than
 * re-deriving it: measured under the same limit, it raises `EFBIG` — loud, and non-zero at the CLI.
 *
 * **It writes from the handle's CURRENT position, which is why this function may be called at most once
 * per handle.** `truncate(0)` does not move the position, and nothing has written through these handles
 * before, so the position is 0. That invariant is not left to trust: "overwrites an existing `--out`
 * completely" hashes the file on disk against the checksum this operation reports, and a write that
 * started anywhere but 0 makes those two disagree.
 */
async function writeOpened(output: OpenOutput, bytes: Buffer): Promise<void> {
  await output.handle.truncate(0);
  await output.handle.writeFile(bytes);
}

/**
 * Whether the file behind this output is STILL the empty one this call created — the only thing the
 * residue policy is entitled to remove.
 *
 * `created` records that this call won the `O_CREAT|O_EXCL` race, and nothing more. It does not say the
 * bytes at that name are still this call's, and by the time a refusal is reached they may not be: a
 * concurrent export sharing the same `--out` opens the very same inode, writes its projection through
 * it, and returns success with a checksum to ITS caller — all inside this call's read stretch. Removing
 * by path alone would delete that finished export. Two questions rule it out:
 *
 * - **`size === 0`**, asked of the DESCRIPTOR. Bytes are not this call's to discard, whoever wrote them.
 *   This is the clause that saves the concurrent export, and it is also why a write that fails PART WAY
 *   leaves its partial bytes behind: the failure is loud, and deleting is the more dangerous answer.
 * - **identity**, `lstat` of the path against the same descriptor's `dev`/`ino`. Never unlink a file
 *   that merely inherited the NAME — the mistake this operation is careful not to make about writing.
 *
 * A residual window remains between these questions and the `unlink`: a concurrent writer could add
 * bytes in that gap and lose them. It is two syscalls wide rather than the whole read stretch, and
 * closing it needs an `funlinkat` POSIX does not provide. Any failure to answer means `false` — when
 * unsure, leave the file alone.
 */
async function isStillTheEmptyFileWeCreated(output: OpenOutput): Promise<boolean> {
  try {
    const opened = await output.handle.stat();
    if (opened.size !== 0) return false;
    const named = await lstat(output.path);
    return named.dev === opened.dev && named.ino === opened.ino;
  } catch {
    return false;
  }
}

/**
 * THE RESIDUE POLICY: on any exit other than success, this operation removes the files it created AND
 * has left empty — nothing else, ever.
 *
 * `O_CREAT` creates, and the creation happens at the top of the operation, long before the run has been
 * read or either output proven. Every path that leads out of here other than success therefore leaves an
 * empty file it has no business leaving, so it takes that back. `isStillTheEmptyFileWeCreated` states
 * what "its own" means and why the obvious reading of it — "the path I created" — is wrong. The two
 * consequences worth naming here:
 *
 * - **A file that already existed is neither emptied nor removed.** Its bytes survive because nothing
 *   truncated them (`openOutput` withholds `O_TRUNC`), and deleting an operator's previous export
 *   because the OTHER output turned out to be a hard link would make this guard destructive in its own
 *   right.
 * - **A write that failed part way keeps its partial bytes**, and the failure is loud (`writeOpened`
 *   writes every byte or throws). That is the same answer `fs.writeFile` gave before this operation
 *   moved to descriptors.
 *
 * **Nothing here may replace the error the operation is already carrying.** This runs in a `finally`, so
 * a throw from a cleanup step becomes the error the operator sees, and a refusal disappears behind an
 * `EACCES` from `unlink`. Each removal is therefore attempted independently and its failure absorbed —
 * one failing removal must neither mask the refusal nor cancel the other file's. The cost is honest: an
 * un-removable created file stays on disk, which is residue, and residue is the lesser harm next to a
 * lost diagnosis. A CLOSE failure is different, and is absorbed only on the failing path: on the
 * SUCCEEDING path it is the only signal that bytes reported as written may not have reached the disk, so
 * it is raised after every handle has been closed.
 *
 * Handles close BEFORE any removal, unconditionally: Windows cannot be relied on to unlink a name that
 * still has an open handle, and POSIX does not care about the order.
 */
async function releaseOutputs(outputs: readonly OpenOutput[], completed: boolean): Promise<void> {
  const removable: string[] = [];
  let closeFailure: Error | undefined;
  for (const output of outputs) {
    if (!completed && output.created && await isStillTheEmptyFileWeCreated(output)) removable.push(output.path);
    try {
      await output.handle.close();
    } catch (error: unknown) {
      // Normalized rather than rethrown raw so the FIRST failure survives while later handles still get
      // closed. `close` rejects with a Node `Error`; the fallback exists so a non-Error rejection cannot
      // become a thrown non-error.
      closeFailure ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  for (const path of removable) {
    try { await rm(path, { force: true }); } catch { /* Residue is the lesser harm; see above. */ }
  }
  if (completed && closeFailure !== undefined) throw closeFailure;
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
 * derived from its name — are proved before EITHER is written, and proved twice over, because one
 * question cannot cover both shapes of the attack:
 *
 * 1. `assertOutputsAreOutsideTheRuns` asks it of the PATHS, symlinks resolved, against the whole results
 *    root. Only this sees an `--out` that simply points inside `qa-results/`.
 * 2. `assertOutputsHaveOneName` asks it of the DESCRIPTORS about to be written. Only this sees a hard
 *    link, which no `realpath` can perceive because a second name for an inode is the file itself.
 *
 * Between them the two routes Phase 8a left open are closed. The descriptors are opened at the top,
 * beside the path guard and ahead of the read stretch, so a symlink planted at an output path during
 * that stretch no longer redirects anything: the write goes to the descriptor, not to the name. On
 * Windows one clause of that is unavailable — see `openNoFollow`, which says exactly which.
 *
 * **Every byte lands, or the export fails loudly.** `writeOpened` uses a call that loops until the whole
 * buffer is written; a single `pwrite` reports a SHORT count without throwing, and the state that
 * produces — a truncated projection with a sidecar certifying bytes it does not contain — is precisely
 * the one the sidecar exists to make impossible. `projectionSha256` is therefore never returned for
 * bytes that did not reach the file.
 *
 * **A refusal leaves the filesystem as it found it.** Opening early means an empty file may exist at
 * either output path before the run has even been read, so every exit other than success removes those
 * empty files. It removes NOTHING else — not a file that already existed, not a file another export
 * finished writing through the same name, not a different file that took the name over.
 * `isStillTheEmptyFileWeCreated` says how those are told apart and what window remains; `releaseOutputs`
 * says why a cleanup failure is absorbed rather than raised.
 *
 * What is NOT claimed: that a hard-linked output is distinguished from a legitimate one.
 * `assertOutputsHaveOneName` refuses every second-named output, an operator's deliberate one included,
 * because a descriptor cannot say where its other names are.
 */
export async function exportProjection(options: Readonly<{ root: string; runId: string; format: string; outPath: string }>): Promise<ExportProjectionResult> {
  if (!isFormat(options.format)) throw new QaSkillsError(`Unsupported projection format ${options.format}: use junit or sarif`, "INVALID_ARTIFACT");
  const outPath = resolve(options.outPath);
  const sidecarPath = `${outPath}.provenance.json`;
  const workspace = await RunWorkspace.open(options.root, options.runId);
  try {
    await assertOutputsAreOutsideTheRuns(dirname(workspace.path), [outPath, sidecarPath]);
    // Opened HERE, beside the path guard, rather than at the writes: everything below this line is the
    // slow stretch, and a descriptor obtained before it cannot be redirected during it.
    const [projection, sidecar] = await openOutputs(outPath, sidecarPath);
    let completed = false;
    try {
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
      // Only the SARIF renderer answers the "could every observed failure be placed?" question, because
      // only its output has a field to place one IN. JUnit's branch declines to answer rather than
      // answering `0`; see `observedResultsWithoutLocation` on the result type.
      const projected = options.format === "junit" ? { document: renderJUnit(model) } : renderSarif(model);
      const rendered = Buffer.from(projected.document, "utf8");
      // BOTH descriptors proven before EITHER is truncated. Proving each one just before its own write
      // would leave a projection on disk that nothing vouches for the moment the sidecar is refused.
      await assertOutputsHaveOneName([projection, sidecar]);
      // The projection is written first and the sidecar second, so a sidecar never describes bytes that
      // do not exist. The reverse order would leave a provenance claim about a missing file.
      await writeOpened(projection, rendered);
      await writeOpened(sidecar, Buffer.from(renderSidecar(model, options.format, rendered), "utf8"));
      completed = true;
      return {
        format: options.format, outPath, sidecarPath,
        projectionSha256: projectionChecksum(rendered),
        recommendation: model.gate.recommendation, reduced: model.reduced,
        unreadableRunnerReports: unreadable,
        ...("observedResultsWithoutLocation" in projected ? { observedResultsWithoutLocation: projected.observedResultsWithoutLocation } : {}),
      };
    } finally {
      await releaseOutputs([projection, sidecar], completed);
    }
  } finally {
    await workspace.close();
  }
}
