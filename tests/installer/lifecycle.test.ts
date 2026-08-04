import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installSkills } from "../../src/installer/install.js";
import { updateSkills } from "../../src/installer/update.js";
import { verifySkills } from "../../src/installer/verify.js";
import { uninstallSkills } from "../../src/installer/uninstall.js";
import { runCli } from "../../src/cli/program.js";
import { resolveCompatibleRuntime } from "../../src/installer/agents.js";
import { manifestFilename } from "../../src/installer/manifest.js";
import { projectRuntimePath, writeProjectRuntime } from "./runtime-fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ sourceRoot: string; projectRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "qa-skill-installer-")); roots.push(root);
  const sourceRoot = join(root, "bundle");
  await writeFile(join(sourceRoot, "qa-tester", "SKILL.md"), "---\nname: qa-tester\ndescription: Test\n---\n", { encoding: "utf8", flag: "w" }).catch(async () => {
    const { mkdir } = await import("node:fs/promises"); await mkdir(join(sourceRoot, "qa-tester"), { recursive: true });
    await writeFile(join(sourceRoot, "qa-tester", "SKILL.md"), "---\nname: qa-tester\ndescription: Test\n---\n");
  });
  const projectRoot = join(root, "project");
  await writeProjectRuntime(projectRoot);
  return { sourceRoot, projectRoot };
}

describe("portable skill installer", () => {
  it("installs copied files and verifies an unchanged manifest", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    await symlink(projectRuntimePath(options.projectRoot), join(options.projectRoot, "node_modules", ".bin", "linked-tool"));
    const installed = await installSkills(options);
    expect(installed.root).toMatch(/\.codex[\\/]skills$/);
    expect(await readFile(join(installed.root, "qa-tester", "SKILL.md"), "utf8")).toContain("name: qa-tester");
    const manifest = JSON.parse(await readFile(join(installed.root, manifestFilename), "utf8")) as { runtime: { command: string; resolvedPath: string; source: string; version: string; sha256: string } };
    expect(manifest.runtime).toMatchObject({ command: projectRuntimePath(options.projectRoot), source: "project", version: "1.0.0" });
    expect(manifest.runtime.resolvedPath).toBe(await realpath(manifest.runtime.command));
    expect(manifest.runtime.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await verifySkills(options)).toMatchObject({ status: "valid", runtime: { status: "valid", expected: manifest.runtime, actual: manifest.runtime } });
  });

  it("reports a changed, incompatible, or missing recorded runtime binding with typed verification status", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    await installSkills(options);
    const runtime = projectRuntimePath(options.projectRoot);

    await writeProjectRuntime(options.projectRoot, "1.0.0", "compatible but different identity");
    expect(await verifySkills(options)).toMatchObject({ status: "runtime-changed", runtime: { status: "runtime-changed" } });
    // "9.0.0" still asserts incompatible, but it and any 0.x version now fail the same regex
    // clause in isRuntimeCompatible (see manifest.ts): this case no longer distinguishes
    // "an unfamiliar future version" from "our own superseded 0.x line."
    await writeProjectRuntime(options.projectRoot, "9.0.0");
    expect(await verifySkills(options)).toMatchObject({ status: "runtime-incompatible", runtime: { status: "runtime-incompatible" } });
    await rm(runtime);
    expect(await verifySkills(options)).toMatchObject({ status: "runtime-missing", runtime: { status: "runtime-missing" } });
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
    await writeProjectRuntime(root);
    const installed = await runCli(["skills", "install", "--agent", "cursor"], { cwd: root });
    expect(installed.exitCode).toBe(0);
    expect(JSON.parse(installed.stdout)).toMatchObject({ root: join(root, ".cursor", "skills") });
    const verified = await runCli(["skills", "verify", "--agent", "cursor"], { cwd: root });
    expect(verified.exitCode).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ status: "valid" });
    expect((await runCli(["skills", "install", "--agent", "cursor"], { cwd: root })).exitCode).toBe(4);
    expect((await runCli(["skills", "update", "--agent", "codex"], { cwd: root })).exitCode).toBe(3);
    const installedRoot = join(root, ".cursor", "skills"); await writeFile(join(installedRoot, "qa-tester", "SKILL.md"), "drift");
    expect((await runCli(["skills", "update", "--agent", "cursor"], { cwd: root })).exitCode).toBe(4);
    const forced = await runCli(["skills", "update", "--agent", "cursor", "--force"], { cwd: root }); expect(forced.exitCode).toBe(0); expect((JSON.parse(forced.stdout) as { backupRoot?: string }).backupRoot).toBeTruthy();
    await writeFile(join(installedRoot, "qa-tester", "SKILL.md"), "leftover");
    expect((await runCli(["skills", "uninstall", "--agent", "cursor"], { cwd: root })).exitCode).toBe(1);
  });

  it("reports every drift status and refuses symlink targets", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    const skill = join(installed.root, "qa-tester", "SKILL.md");
    expect((await verifySkills(options)).status).toBe("valid");
    await writeFile(skill, "changed"); expect((await verifySkills(options)).status).toBe("modified");
    await rm(skill); expect((await verifySkills(options)).status).toBe("missing");
    await writeFile(skill, "---\nname: qa-tester\ndescription: Test\n---\n");
    await writeFile(join(installed.root, "qa-tester", "extra.txt"), "extra"); expect((await verifySkills(options)).status).toBe("unexpected");
    const unsafe = await fixture(); await mkdir(unsafe.projectRoot, { recursive: true }); await symlink(join(unsafe.projectRoot, "outside"), join(unsafe.projectRoot, ".codex"));
    await expect(installSkills({ ...unsafe, agent: "codex", target: "project" })).rejects.toThrow(/symlink|safe/i);
    const unsafeSource = await fixture(); await symlink(join(unsafeSource.sourceRoot, "qa-tester", "SKILL.md"), join(unsafeSource.sourceRoot, "qa-tester", "linked.md"));
    await expect(installSkills({ ...unsafeSource, agent: "codex", target: "project" })).rejects.toThrow(/symlink|safe/i);
  });

  it("prefers and executes the project runtime, rejects incompatible versions, and never falls back remotely", async () => {
    const options = await fixture();
    const resolved = await resolveCompatibleRuntime(options.projectRoot, "");
    expect(resolved).toMatchObject({ source: "project", version: "1.0.0" });
    await writeProjectRuntime(options.projectRoot, "nope");
    await expect(installSkills({ ...options, agent: "codex", target: "project" })).rejects.toThrow(/version|compatible|setup/i);
  });

  it("rolls back clean install and update failures at write and swap boundaries", async () => {
    for (const boundary of ["stage:first", "write:middle", "write:final"] as const) {
      const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
      await expect(installSkills({ ...options, failureInjector: (phase) => { if (phase === boundary) throw new Error("injected"); } })).rejects.toThrow("injected");
      await expect(readFile(join(options.projectRoot, ".codex", "skills", "qa-tester", "SKILL.md"), "utf8")).rejects.toThrow();
    }
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options); const before = await readFile(join(installed.root, "qa-tester", "SKILL.md"), "utf8");
    await expect(updateSkills({ ...options, failureInjector: (phase) => { if (phase === "swap") throw new Error("swap injected"); } })).rejects.toThrow("swap injected");
    expect(await readFile(join(installed.root, "qa-tester", "SKILL.md"), "utf8")).toBe(before);
  });
});
