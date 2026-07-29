import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installSkills } from "../../src/installer/install.js";
import { updateSkills } from "../../src/installer/update.js";
import { verifySkills } from "../../src/installer/verify.js";
import { uninstallSkills } from "../../src/installer/uninstall.js";
import { codexManagedInner, removeCodexBlock, upsertCodexBlock } from "../../src/installer/shims.js";
import { runCli } from "../../src/cli/program.js";
import { manifestFilename } from "../../src/installer/manifest.js";
import { QaSkillsError } from "../../src/core/errors.js";
import { writeProjectRuntime } from "./runtime-fixture.js";

const CODEX_START = "<!-- qa-skills:start (managed by qa-skill; do not edit inside) -->";
const CODEX_END = "<!-- qa-skills:end -->";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ sourceRoot: string; projectRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "qa-skill-shims-")); roots.push(root);
  const sourceRoot = join(root, "bundle");
  for (const name of ["qa-tester", "bug-reporter"]) {
    await mkdir(join(sourceRoot, name), { recursive: true });
    await writeFile(join(sourceRoot, name, "SKILL.md"), `---\nname: ${name}\ndescription: Test\n---\n`);
  }
  // A non-skill shared references directory must not be treated as a skill.
  await mkdir(join(sourceRoot, "shared", "references"), { recursive: true });
  await writeFile(join(sourceRoot, "shared", "references", "safety.md"), "shared\n");
  const projectRoot = join(root, "project");
  await writeProjectRuntime(projectRoot);
  return { sourceRoot, projectRoot };
}

type ManifestShape = { shims: readonly { path: string; sha256: string }[] };
async function readManifestShims(root: string): Promise<ManifestShape["shims"]> {
  return (JSON.parse(await readFile(join(root, manifestFilename), "utf8")) as ManifestShape).shims;
}

describe("per-agent discovery shims (ADR-0011)", () => {
  it("generates a codex AGENTS.md managed block pointing at canonical SKILL.md files", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    const content = await readFile(join(options.projectRoot, "AGENTS.md"), "utf8");
    expect(content).toContain("qa-skills:start");
    expect(content).toContain("qa-skills:end");
    expect(content).toContain(".codex/skills/qa-tester/SKILL.md");
    expect(content).toContain(".codex/skills/bug-reporter/SKILL.md");
    // No skill content is duplicated into the shim — pointers only.
    expect(content).not.toContain("description: Test");
    // The shared/references directory is not a skill.
    expect(content).not.toContain("shared/references");
    expect(await readManifestShims(installed.root)).toEqual([{ path: "AGENTS.md", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  });

  it("generates a cursor .cursor/rules/qa-skills.mdc shim and records it", async () => {
    const options = { ...(await fixture()), agent: "cursor" as const, target: "project" as const };
    const installed = await installSkills(options);
    const content = await readFile(join(options.projectRoot, ".cursor", "rules", "qa-skills.mdc"), "utf8");
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("alwaysApply: false");
    expect(content).toContain(".cursor/skills/qa-tester/SKILL.md");
    expect(await readManifestShims(installed.root)).toEqual([{ path: ".cursor/rules/qa-skills.mdc", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  });

  it("generates no shim for claude native discovery", async () => {
    const options = { ...(await fixture()), agent: "claude" as const, target: "project" as const };
    const installed = await installSkills(options);
    await expect(readFile(join(options.projectRoot, "AGENTS.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(options.projectRoot, ".cursor", "rules", "qa-skills.mdc"), "utf8")).rejects.toThrow();
    expect(await readManifestShims(installed.root)).toEqual([]);
  });

  it("preserves pre-existing AGENTS.md user content and stays idempotent across update", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const agentsPath = join(options.projectRoot, "AGENTS.md");
    await writeFile(agentsPath, "# My Project\n\nUser instructions stay here.\n");
    await installSkills(options);
    let content = await readFile(agentsPath, "utf8");
    expect(content).toContain("# My Project");
    expect(content).toContain("User instructions stay here.");
    expect(content).toContain("qa-skills:start");
    await updateSkills(options);
    content = await readFile(agentsPath, "utf8");
    expect(content).toContain("User instructions stay here.");
    expect(content.match(/qa-skills:start/g)).toHaveLength(1);
    expect(content.match(/qa-skills:end/g)).toHaveLength(1);
  });

  it("verify returns non-valid with a shim finding when the codex managed block is tampered", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    await installSkills(options);
    expect((await verifySkills(options)).status).toBe("valid");
    const agentsPath = join(options.projectRoot, "AGENTS.md");
    await writeFile(agentsPath, (await readFile(agentsPath, "utf8")).replace("qa-tester", "tampered-name"));
    const verification = await verifySkills(options);
    expect(verification.status).not.toBe("valid");
    expect(verification.shims.some((shim) => shim.status === "modified")).toBe(true);
  });

  it("verify returns missing when the cursor shim is deleted", async () => {
    const options = { ...(await fixture()), agent: "cursor" as const, target: "project" as const };
    await installSkills(options);
    expect((await verifySkills(options)).status).toBe("valid");
    await rm(join(options.projectRoot, ".cursor", "rules", "qa-skills.mdc"));
    const verification = await verifySkills(options);
    expect(verification.status).toBe("missing");
    expect(verification.shims.some((shim) => shim.status === "missing")).toBe(true);
  });

  it("verify returns missing when the codex managed block is removed but AGENTS.md remains", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    await installSkills(options);
    const agentsPath = join(options.projectRoot, "AGENTS.md");
    await writeFile(agentsPath, "# Only user content now.\n");
    const verification = await verifySkills(options);
    expect(verification.status).toBe("missing");
    expect(verification.shims.some((shim) => shim.status === "missing")).toBe(true);
  });

  it("uninstall removes the codex managed block but preserves surrounding user content", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const agentsPath = join(options.projectRoot, "AGENTS.md");
    await writeFile(agentsPath, "# My Project\n\nUser instructions stay here.\n");
    await installSkills(options);
    await uninstallSkills(options);
    const content = await readFile(agentsPath, "utf8");
    expect(content).toContain("User instructions stay here.");
    expect(content).not.toContain("qa-skills:start");
  });

  it("uninstall removes an AGENTS.md that held only the managed block", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    await installSkills(options);
    await uninstallSkills(options);
    await expect(readFile(join(options.projectRoot, "AGENTS.md"), "utf8")).rejects.toThrow();
  });

  it("uninstall removes the cursor .mdc shim", async () => {
    const options = { ...(await fixture()), agent: "cursor" as const, target: "project" as const };
    await installSkills(options);
    const mdc = join(options.projectRoot, ".cursor", "rules", "qa-skills.mdc");
    expect(await readFile(mdc, "utf8")).toContain("qa-tester");
    await uninstallSkills(options);
    await expect(readFile(mdc, "utf8")).rejects.toThrow();
  });

  it("verifies a pre-ADR-0011 manifest that has no shims field", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    const manifestPath = join(installed.root, manifestFilename);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.shims;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    // Removing the AGENTS.md shim too proves the old manifest verifies without any shim check.
    await rm(join(options.projectRoot, "AGENTS.md"));
    const verification = await verifySkills(options);
    expect(verification.status).toBe("valid");
    expect(verification.shims).toEqual([]);
  });

  it("CLI verify exits UNMET_OBLIGATIONS when a codex shim goes stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-skill-shim-cli-")); roots.push(root);
    await writeProjectRuntime(root);
    expect((await runCli(["skills", "install", "--agent", "codex"], { cwd: root })).exitCode).toBe(0);
    expect((await runCli(["skills", "verify", "--agent", "codex"], { cwd: root })).exitCode).toBe(0);
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, (await readFile(agentsPath, "utf8")).replace("qa-tester", "nope"));
    expect((await runCli(["skills", "verify", "--agent", "codex"], { cwd: root })).exitCode).toBe(1);
  });

  it("never deletes user content around a dangling qa-skills:start marker (install/update/verify)", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const agentsPath = join(options.projectRoot, "AGENTS.md");
    const before = `# My Project\n\nFirst user paragraph.\n\n${CODEX_START}\n\nSecond user paragraph after a dangling start (no end marker).\n`;
    await writeFile(agentsPath, before);
    // A malformed managed marker must make install refuse rather than mangle the file.
    await expect(installSkills(options)).rejects.toThrow(QaSkillsError);
    expect(await readFile(agentsPath, "utf8")).toBe(before);
    // verify must not crash and must not mutate the file.
    await verifySkills(options);
    // update --force is the tool's own recommended remedy for drift; it must NEVER delete content.
    await expect(updateSkills({ ...options, force: true })).rejects.toThrow(QaSkillsError);
    const after = await readFile(agentsPath, "utf8");
    expect(after).toContain("First user paragraph.");
    expect(after).toContain("Second user paragraph after a dangling start (no end marker).");
    expect(after).toBe(before);
  });

  it("refuses (throws) on malformed markers for the write and remove paths, deriving no inner content", () => {
    const block = `${CODEX_START}\nBODY\n${CODEX_END}`;
    const dangling = `before\n${CODEX_START}\nno end here\n`;
    const nested = `${CODEX_START}\nouter\n${CODEX_START}\ninner\n${CODEX_END}\n`;
    const doubleBlock = `x\n${CODEX_START}\nA\n${CODEX_END}\n${CODEX_START}\nB\n${CODEX_END}\n`;
    for (const bad of [dangling, nested, doubleBlock]) {
      expect(() => upsertCodexBlock(bad, block)).toThrow(QaSkillsError);
      expect(() => removeCodexBlock(bad)).toThrow(QaSkillsError);
      // The verify derivation returns nothing instead of pairing the wrong markers.
      expect(codexManagedInner(bad)).toBeUndefined();
    }
  });

  it("appends exactly one block when AGENTS.md holds only an orphan qa-skills:end, idempotent across update", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const agentsPath = join(options.projectRoot, "AGENTS.md");
    await writeFile(agentsPath, `Intro user text.\n\n${CODEX_END}\n\nTrailing user text.\n`);
    await installSkills(options);
    let content = await readFile(agentsPath, "utf8");
    expect(content.match(/qa-skills:start/g)).toHaveLength(1);
    expect(content).toContain("Intro user text.");
    expect(content).toContain("Trailing user text.");
    expect((await verifySkills(options)).status).toBe("valid");
    await updateSkills(options);
    content = await readFile(agentsPath, "utf8");
    expect(content.match(/qa-skills:start/g)).toHaveLength(1);
  });

  it("is verify-valid immediately after a fresh install into clean AGENTS.md", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    await writeFile(join(options.projectRoot, "AGENTS.md"), "# Notes\n\nPlain user notes, no markers.\n");
    await installSkills(options);
    expect((await verifySkills(options)).status).toBe("valid");
  });

  it("update --force backs up the codex AGENTS.md shim before overwriting it", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    await installSkills(options);
    const agentsPath = join(options.projectRoot, "AGENTS.md");
    await writeFile(agentsPath, (await readFile(agentsPath, "utf8")).replace("qa-tester", "drifted-name"));
    await expect(updateSkills(options)).rejects.toThrow(/drift/i);
    const updated = await updateSkills({ ...options, force: true });
    const backupRoot = updated.backupRoot ?? "";
    expect(backupRoot).not.toBe("");
    const backedUp = await readFile(join(backupRoot, "shims", "AGENTS.md"), "utf8");
    expect(backedUp).toContain("qa-skills:start");
    expect(backedUp).toContain("drifted-name");
  });

  it("update --force backs up the cursor .mdc shim before overwriting it", async () => {
    const options = { ...(await fixture()), agent: "cursor" as const, target: "project" as const };
    await installSkills(options);
    const mdc = join(options.projectRoot, ".cursor", "rules", "qa-skills.mdc");
    await writeFile(mdc, `${await readFile(mdc, "utf8")}\n<!-- drift -->\n`);
    const updated = await updateSkills({ ...options, force: true });
    const backupRoot = updated.backupRoot ?? "";
    expect(backupRoot).not.toBe("");
    expect(await readFile(join(backupRoot, "shims", ".cursor", "rules", "qa-skills.mdc"), "utf8")).toContain("<!-- drift -->");
  });

  it("keeps verify valid after a user edit OUTSIDE the codex managed block", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const agentsPath = join(options.projectRoot, "AGENTS.md");
    await writeFile(agentsPath, "# Title\n\nOriginal intro.\n");
    await installSkills(options);
    expect((await verifySkills(options)).status).toBe("valid");
    const content = await readFile(agentsPath, "utf8");
    await writeFile(agentsPath, `Prepended note.\n\n${content}\n\nAppended note after the block.\n`);
    expect((await verifySkills(options)).status).toBe("valid");
  });

  it("never destroys the installed bundle on update --force when AGENTS.md markers are malformed", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    const skillPath = join(installed.root, "qa-tester", "SKILL.md");
    const manifestPath = join(installed.root, manifestFilename);
    expect(await readFile(skillPath, "utf8")).toContain("qa-tester");
    // Corrupt the managed markers with a duplicate start — upsertCodexBlock must then refuse.
    const agentsPath = join(options.projectRoot, "AGENTS.md");
    await writeFile(agentsPath, `${await readFile(agentsPath, "utf8")}\n${CODEX_START}\n`);
    // update --force is the tool's own documented remedy for drift. Whether it fails fast on the
    // marker fault or degrades to a safe half-install, the COMMITTED bundle must never be rolled back.
    let updateError: unknown;
    try { await updateSkills({ ...options, force: true }); } catch (error) { updateError = error; }
    // The installed bundle SURVIVES in every case: SKILL.md + manifest + the root dir all intact.
    expect(await readFile(skillPath, "utf8")).toContain("qa-tester");
    expect(await readFile(manifestPath, "utf8")).toContain("qa-tester");
    expect((await stat(installed.root)).isDirectory()).toBe(true);
    // ...and the marker fault is surfaced: either it threw, or verify now flags the missing shim.
    if (updateError === undefined) {
      expect((await verifySkills(options)).status).not.toBe("valid");
    } else {
      expect(updateError).toBeInstanceOf(QaSkillsError);
    }
  });

  it("aborts a fresh install cleanly when AGENTS.md markers are already malformed", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const agentsPath = join(options.projectRoot, "AGENTS.md");
    const before = `# Notes\n\n${CODEX_START}\n\n${CODEX_START}\n`;
    await writeFile(agentsPath, before);
    await expect(installSkills(options)).rejects.toThrow(QaSkillsError);
    // Nothing is half-written: no SKILL.md, no manifest under the skills root, and AGENTS.md is untouched.
    await expect(readFile(join(options.projectRoot, ".codex", "skills", "qa-tester", "SKILL.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(options.projectRoot, ".codex", "skills", manifestFilename), "utf8")).rejects.toThrow();
    expect(await readFile(agentsPath, "utf8")).toBe(before);
  });
});
