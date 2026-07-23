import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installSkills } from "../../src/installer/install.js";
import { updateSkills } from "../../src/installer/update.js";
import { verifySkills } from "../../src/installer/verify.js";
import { uninstallSkills } from "../../src/installer/uninstall.js";
import { runCli } from "../../src/cli/program.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ sourceRoot: string; projectRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "qa-skill-installer-")); roots.push(root);
  const sourceRoot = join(root, "bundle");
  await writeFile(join(sourceRoot, "qa-tester", "SKILL.md"), "---\nname: qa-tester\ndescription: Test\n---\n", { encoding: "utf8", flag: "w" }).catch(async () => {
    const { mkdir } = await import("node:fs/promises"); await mkdir(join(sourceRoot, "qa-tester"), { recursive: true });
    await writeFile(join(sourceRoot, "qa-tester", "SKILL.md"), "---\nname: qa-tester\ndescription: Test\n---\n");
  });
  return { sourceRoot, projectRoot: join(root, "project") };
}

describe("portable skill installer", () => {
  it("installs copied files and verifies an unchanged manifest", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    expect(installed.root).toMatch(/\.codex[\\/]skills$/);
    expect(await readFile(join(installed.root, "qa-tester", "SKILL.md"), "utf8")).toContain("name: qa-tester");
    expect((await verifySkills(options)).status).toBe("valid");
  });

  it("uses the requested user home instead of the project for user installs", async () => {
    const fixtureOptions = await fixture();
    const installed = await installSkills({ ...fixtureOptions, userHome: join(fixtureOptions.projectRoot, "home"), agent: "cursor", target: "user" });
    expect(installed.root).toBe(join(fixtureOptions.projectRoot, "home", ".cursor", "skills"));
  });

  it("refuses update on drift, backs it up with force, and preserves modified leftovers", async () => {
    const options = { ...(await fixture()), agent: "claude" as const, target: "project" as const };
    const installed = await installSkills(options);
    const skill = join(installed.root, "qa-tester", "SKILL.md");
    await writeFile(skill, "modified");
    expect((await verifySkills(options)).status).toBe("modified");
    await expect(updateSkills(options)).rejects.toThrow(/drift/i);
    const updated = await updateSkills({ ...options, force: true });
    expect(updated.backupRoot).toBeTruthy();
    await writeFile(skill, "modified again");
    const removed = await uninstallSkills(options);
    expect(removed.leftovers).toContain(skill);
  });

  it("wires lifecycle commands through the CLI without fetching a remote runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-skill-cli-install-")); roots.push(root);
    const installed = await runCli(["skills", "install", "--agent", "cursor"], { cwd: root });
    expect(installed.exitCode).toBe(0);
    expect(JSON.parse(installed.stdout)).toMatchObject({ root: join(root, ".cursor", "skills") });
    const verified = await runCli(["skills", "verify", "--agent", "cursor"], { cwd: root });
    expect(verified.exitCode).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ status: "valid" });
  });
});
