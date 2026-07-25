import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { atomicWriteFile } from "../core/fs.js";
import { QaSkillsError } from "../core/errors.js";
import { sha256Text } from "../core/checksum.js";
import { agentSkillsRelativeDir, type AgentName } from "./agents.js";
import { validateRelativeFilePath, type ShimEntry } from "./manifest.js";

/**
 * Per-agent discovery shims (ADR-0011). A shim is a small vendor-shaped pointer
 * that tells an agent where the copied canonical `SKILL.md` files live. Shims
 * carry NO skill content, so ADR-0006's "no skill defined twice" guarantee holds.
 *
 * - Codex reads `AGENTS.md`: we own a marker-delimited managed block inside it
 *   and never touch content outside the markers.
 * - Cursor reads `.cursor/rules/*.mdc`: we own a dedicated file outright.
 * - Claude reads `.claude/skills/<name>/SKILL.md` natively: no shim needed.
 */
export const CODEX_SHIM_PATH = "AGENTS.md";
export const CURSOR_SHIM_PATH = ".cursor/rules/qa-skills.mdc";

const CODEX_MARKER_START = "<!-- qa-skills:start (managed by qa-skill; do not edit inside) -->";
const CODEX_MARKER_END = "<!-- qa-skills:end -->";

const MALFORMED_MARKERS_MESSAGE =
  `The qa-skills managed markers in ${CODEX_SHIM_PATH} are malformed: a "qa-skills:start" marker without a single matching "qa-skills:end" after it (dangling, nested, or duplicated start). ` +
  `Refusing to modify ${CODEX_SHIM_PATH} so no user content is deleted — fix or remove the qa-skills markers by hand, then retry.`;

/** The bounds of the one well-formed managed region, all offsets into the same content string. */
type CodexBlockLocation = Readonly<{ start: number; innerStart: number; innerEnd: number; end: number }>;

/**
 * Locate the single well-formed managed region as a matched START→END pair: the FIRST `START`,
 * the FIRST `END` after it, with NO other `START` in between (nor anywhere else). Returns
 * `undefined` when no `START` is present — a stray `END` is a benign lone comment, treated as
 * "no managed block". THROWS `INSTALLER_SAFETY` when the markers cannot be resolved to exactly
 * one clean pair (a `START` with no following `END`, a nested/second `START`), so write callers
 * refuse rather than guess which markers to overwrite or delete.
 */
function locateCodexBlock(content: string): CodexBlockLocation | undefined {
  const start = content.indexOf(CODEX_MARKER_START);
  if (start === -1) return undefined;
  const innerStart = start + CODEX_MARKER_START.length;
  // A second START anywhere (nested inside the region or a later duplicate block) is ambiguous.
  if (content.indexOf(CODEX_MARKER_START, innerStart) !== -1) throw new QaSkillsError(MALFORMED_MARKERS_MESSAGE, "INSTALLER_SAFETY");
  const innerEnd = content.indexOf(CODEX_MARKER_END, innerStart);
  if (innerEnd === -1) throw new QaSkillsError(MALFORMED_MARKERS_MESSAGE, "INSTALLER_SAFETY");
  return { start, innerStart, innerEnd, end: innerEnd + CODEX_MARKER_END.length };
}

/** A shim ready to record in the manifest (`entry`) and to write to disk. */
export type ShimArtifact = Readonly<{
  entry: ShimEntry;
  /** The full managed block to upsert into a shared file, when the shim is a managed block. */
  block?: string;
  /** The whole-file contents, when the shim owns a dedicated file. */
  file?: string;
}>;

/** A skill is a top-level directory in the bundle that contains a `SKILL.md`. */
export function deriveSkillNames(files: readonly string[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    if (parts.length === 2 && parts[1] === "SKILL.md" && parts[0]) names.add(parts[0]);
  }
  return [...names].sort();
}

function pointerLines(agent: AgentName, skillNames: readonly string[]): string {
  const dir = agentSkillsRelativeDir(agent);
  return skillNames.map((name) => `- \`${name}\`: \`${dir}/${name}/SKILL.md\``).join("\n");
}

/** The Codex managed block: markers wrapping a pointer body. */
export function renderCodexBlock(agent: AgentName, skillNames: readonly string[]): string {
  const body = `\n## QA Skills (managed by qa-skill)\n\nThese QA skills are installed for this project. Read each canonical \`SKILL.md\` for the actual instructions; this block is a pointer only and defines no skills itself.\n\n${pointerLines(agent, skillNames)}\n`;
  return `${CODEX_MARKER_START}${body}${CODEX_MARKER_END}`;
}

/** The Cursor rule file: a short frontmatter plus a pointer body. */
export function renderCursorMdc(agent: AgentName, skillNames: readonly string[]): string {
  return `---\ndescription: QA Skills discovery — pointers to canonical SKILL.md files under ${agentSkillsRelativeDir(agent)}.\nalwaysApply: false\n---\n\n# QA Skills (managed by qa-skill)\n\nThese QA skills are installed for this project. Read each canonical \`SKILL.md\` for the actual instructions; this file is a pointer only and defines no skills itself.\n\n${pointerLines(agent, skillNames)}\n`;
}

/**
 * Extract the inner (checksummed) text of the well-formed managed block, or `undefined` if no
 * block is present. Used by `verify`, which reads possibly-broken on-disk content: on malformed
 * markers it derives no content (the shim is then reported missing) instead of pairing the wrong
 * markers, so verify never silently checksums an ambiguous span.
 */
export function codexManagedInner(content: string): string | undefined {
  let location: CodexBlockLocation | undefined;
  try {
    location = locateCodexBlock(content);
  } catch (error: unknown) {
    if (error instanceof QaSkillsError && error.code === "INSTALLER_SAFETY") return undefined;
    throw error;
  }
  return location ? content.slice(location.innerStart, location.innerEnd) : undefined;
}

/**
 * Insert or replace the managed block, preserving all content outside the markers. Idempotent.
 * Throws `INSTALLER_SAFETY` (never mutating the file) when the existing markers are malformed.
 */
export function upsertCodexBlock(existing: string, block: string): string {
  const location = locateCodexBlock(existing);
  if (location) return `${existing.slice(0, location.start)}${block}${existing.slice(location.end)}`;
  if (existing.trim().length === 0) return `${block}\n`;
  const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${block}\n`;
}

/**
 * Remove the managed block, preserving surrounding user content. Returns "" when nothing else
 * remains. Throws `INSTALLER_SAFETY` (deleting nothing) when the existing markers are malformed.
 */
export function removeCodexBlock(existing: string): string {
  const location = locateCodexBlock(existing);
  if (!location) return existing;
  const before = existing.slice(0, location.start).replace(/\s+$/, "");
  const after = existing.slice(location.end).replace(/^\s+/, "");
  if (before.length === 0 && after.length === 0) return "";
  const joined = before.length > 0 && after.length > 0 ? `${before}\n\n${after}` : `${before}${after}`;
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}

/** Build the shim artifacts for an agent (empty for Claude). */
export function buildShims(agent: AgentName, skillNames: readonly string[]): ShimArtifact[] {
  if (agent === "codex") {
    const block = renderCodexBlock(agent, skillNames);
    const managed = codexManagedInner(block) ?? "";
    return [{ entry: { path: validateRelativeFilePath(CODEX_SHIM_PATH), sha256: sha256Text(managed) }, block }];
  }
  if (agent === "cursor") {
    const file = renderCursorMdc(agent, skillNames);
    return [{ entry: { path: validateRelativeFilePath(CURSOR_SHIM_PATH), sha256: sha256Text(file) }, file }];
  }
  return [];
}

/** Read the on-disk managed content for a recorded shim, or undefined if the shim/block is absent. */
export async function readShimManagedContent(installRoot: string, shim: ShimEntry): Promise<string | undefined> {
  const target = join(installRoot, ...validateRelativeFilePath(shim.path).split("/"));
  let onDisk: string;
  try {
    onDisk = await readFile(target, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  // A managed block lives inside a shared file; a dedicated shim file is checksummed whole.
  return shim.path === CODEX_SHIM_PATH ? codexManagedInner(onDisk) : onDisk;
}

/**
 * Dry-run the managed-block shim writes against the current on-disk content WITHOUT mutating anything.
 * Throws `INSTALLER_SAFETY` on malformed markers exactly as `writeShims` would — so a caller can abort
 * BEFORE a destructive bundle swap and never leave a committed-then-rolled-back (destroyed) bundle.
 */
export async function assertShimWritable(installRoot: string, artifacts: readonly ShimArtifact[]): Promise<void> {
  for (const artifact of artifacts) {
    if (artifact.block === undefined) continue;
    const target = join(installRoot, ...validateRelativeFilePath(artifact.entry.path).split("/"));
    let existing = "";
    try { existing = await readFile(target, "utf8"); } catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    upsertCodexBlock(existing, artifact.block); // Throws on malformed markers; the result is intentionally discarded.
  }
}

/** Write the shim artifacts to disk under the install root. */
export async function writeShims(installRoot: string, artifacts: readonly ShimArtifact[]): Promise<void> {
  for (const artifact of artifacts) {
    const target = join(installRoot, ...validateRelativeFilePath(artifact.entry.path).split("/"));
    if (artifact.block !== undefined) {
      let existing = "";
      try { existing = await readFile(target, "utf8"); } catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      await atomicWriteFile(installRoot, target, upsertCodexBlock(existing, artifact.block));
    } else if (artifact.file !== undefined) {
      await atomicWriteFile(installRoot, target, artifact.file);
    }
  }
}

/** Remove a recorded shim from disk, preserving user content around managed blocks. */
export async function removeShim(installRoot: string, shim: ShimEntry): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  const target = join(installRoot, ...validateRelativeFilePath(shim.path).split("/"));
  if (shim.path === CODEX_SHIM_PATH) {
    let existing: string;
    try { existing = await readFile(target, "utf8"); } catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
    const remaining = removeCodexBlock(existing);
    if (remaining.length === 0) { await unlink(target); return; }
    await atomicWriteFile(installRoot, target, remaining);
    return;
  }
  try { await unlink(target); } catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  await removeEmptyParents(installRoot, target);
}

async function removeEmptyParents(installRoot: string, path: string): Promise<void> {
  const { readdir, rm } = await import("node:fs/promises");
  let current = dirname(path);
  while (current.startsWith(installRoot) && current !== installRoot) {
    try {
      if ((await readdir(current)).length !== 0) return;
      await rm(current);
      current = dirname(current);
    } catch { return; }
  }
}
