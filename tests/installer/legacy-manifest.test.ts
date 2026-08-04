import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installSkills } from "../../src/installer/install.js";
import { updateSkills } from "../../src/installer/update.js";
import { uninstallSkills } from "../../src/installer/uninstall.js";
import { verifySkills } from "../../src/installer/verify.js";
import { runCli } from "../../src/cli/program.js";
import { manifestFilename, runtimeCompatibility, type SkillManifest } from "../../src/installer/manifest.js";
import { writeProjectRuntime } from "./runtime-fixture.js";

/**
 * I4 (Phase 10, v1.0 contract freeze): every manifest a 0.x install ever wrote records
 * `runtimeRange: ">=0.1.0 <1.0.0"`. `isManifest` (src/installer/manifest.ts) used to gate BOTH
 * `sourceVersion` and `runtime.version` through `isRuntimeCompatible(value, candidate.runtimeRange)`,
 * whose first line is `if (range !== runtimeCompatibility) return false` -- so any manifest whose OWN
 * recorded range differs from this build's literal fails the shape check, `readManifest` throws a bare
 * `Error("Invalid QA skill manifest")`, and `src/cli/program.ts`'s top-level catch maps any non-`QaSkillsError`
 * to `ABORTED_OR_INTERNAL` (exit 5). That is the wrong diagnosis: a 0.x manifest is not corrupt, it is a
 * well-formed manifest of a superseded major. `verifySkills` backs all three lifecycle commands --
 * `skills verify` (src/cli/program.ts), `skills uninstall` (src/installer/uninstall.ts), and `skills
 * update` (src/installer/update.ts) -- so all three broke the same way before this fix.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ sourceRoot: string; projectRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "qa-skill-legacy-manifest-")); roots.push(root);
  const sourceRoot = join(root, "bundle");
  await mkdir(join(sourceRoot, "qa-tester"), { recursive: true });
  await writeFile(join(sourceRoot, "qa-tester", "SKILL.md"), "---\nname: qa-tester\ndescription: Test\n---\n");
  const projectRoot = join(root, "project");
  await writeProjectRuntime(projectRoot);
  return { sourceRoot, projectRoot };
}

/**
 * Rewrites a freshly-installed manifest to look like it was written by a pre-1.0 install: file list,
 * checksums, agent, and target are untouched -- only `sourceVersion`, `runtimeRange`, and
 * `runtime.version` move to a superseded major, exactly what a 0.x `qa-skill skills install` recorded
 * on disk and left behind for a 1.0 install to find.
 */
async function ageManifestToPre1(installedRoot: string): Promise<void> {
  const path = join(installedRoot, manifestFilename);
  const manifest = JSON.parse(await readFile(path, "utf8")) as SkillManifest;
  const aged: SkillManifest = {
    ...manifest,
    sourceVersion: "0.3.0",
    runtimeRange: ">=0.1.0 <1.0.0",
    runtime: { ...manifest.runtime, version: "0.3.0" },
  };
  await writeFile(path, `${JSON.stringify(aged, null, 2)}\n`);
}

describe("skill manifest written by a pre-1.0 install (I4)", () => {
  it("verifySkills reports runtime-incompatible with a reason naming both ranges, not a thrown parse error", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    await ageManifestToPre1(installed.root);

    const verification = await verifySkills(options);
    expect(verification.status).toBe("runtime-incompatible");
    expect(verification.runtime?.status).toBe("runtime-incompatible");
    expect(verification.runtime?.reason).toContain(">=0.1.0 <1.0.0");
    expect(verification.runtime?.reason).toContain(runtimeCompatibility);
  });

  it("qa-skill skills verify exits with the same code other verify drift uses, not exit 5 or the raw parse-error message", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    await ageManifestToPre1(installed.root);

    const result = await runCli(["skills", "verify", "--agent", "codex"], { cwd: options.projectRoot });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("Invalid QA skill manifest");
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "runtime-incompatible" });
  });

  it("uninstallSkills can still remove a pre-1.0-manifest install cleanly", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    await ageManifestToPre1(installed.root);

    const result = await uninstallSkills(options);
    expect(result.leftovers).toEqual([]);
    expect(result.removed.length).toBeGreaterThan(0);
  });

  it("updateSkills refuses in place without --force but upgrades the manifest with --force", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    await ageManifestToPre1(installed.root);

    await expect(updateSkills(options)).rejects.toThrow(/drift/i);
    const updated = await updateSkills({ ...options, force: true });
    expect(updated.backupRoot).toBeTruthy();
    const manifestAfter = JSON.parse(await readFile(join(installed.root, manifestFilename), "utf8")) as SkillManifest;
    expect(manifestAfter.runtimeRange).toBe(runtimeCompatibility);
  });

  it("readManifest still rejects a genuinely malformed manifest -- shape, not major, gates it", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    await writeFile(join(installed.root, manifestFilename), JSON.stringify({ manifestVersion: 2 }));

    await expect(verifySkills(options)).rejects.toThrow(/Invalid QA skill manifest/);
  });
});
