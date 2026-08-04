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

  it("readManifest rejects an otherwise-valid manifest on manifestVersion alone -- isolates that one field, not the whole shape check", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    const path = join(installed.root, manifestFilename);
    const manifest = JSON.parse(await readFile(path, "utf8")) as SkillManifest;
    await writeFile(path, JSON.stringify({ ...manifest, manifestVersion: 2 }));

    await expect(verifySkills(options)).rejects.toThrow(/Invalid QA skill manifest/);
  });

  it("readManifest rejects a sha256 that is not 64 lowercase hex characters, everything else left valid", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    const path = join(installed.root, manifestFilename);
    const manifest = JSON.parse(await readFile(path, "utf8")) as SkillManifest;
    await writeFile(path, JSON.stringify({ ...manifest, runtime: { ...manifest.runtime, sha256: "not-a-checksum" } }));

    await expect(verifySkills(options)).rejects.toThrow(/Invalid QA skill manifest/);
  });
});

/**
 * I2 (review round 1, C1 sibling): I4 above dropped ONLY the 1.x-only lock on `sourceVersion` and
 * `runtime.version` -- it must not also drop the requirement that those two fields and the
 * manifest's own `runtimeRange` all name the SAME major. Each case below is otherwise a real,
 * freshly-installed manifest (same files, same checksums, same agent/target) with exactly one axis
 * changed, so a mutation that re-widens any single guard turns exactly the matching test red rather
 * than several at once.
 */
describe("I2: runtimeRange, sourceVersion, and runtime.version must share one major", () => {
  it("readManifest rejects a runtimeRange that does not parse as >=X.Y.Z <A.B.C at all, even though every other field is otherwise valid", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    const path = join(installed.root, manifestFilename);
    const manifest = JSON.parse(await readFile(path, "utf8")) as SkillManifest;
    await writeFile(path, JSON.stringify({ ...manifest, runtimeRange: "banana" }));

    await expect(verifySkills(options)).rejects.toThrow(/Invalid QA skill manifest/);
  });

  it("readManifest rejects a manifest whose runtimeRange is current but sourceVersion names a different major", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    const path = join(installed.root, manifestFilename);
    const manifest = JSON.parse(await readFile(path, "utf8")) as SkillManifest;
    await writeFile(path, JSON.stringify({ ...manifest, sourceVersion: "0.0.1" }));

    await expect(verifySkills(options)).rejects.toThrow(/Invalid QA skill manifest/);
  });

  it("readManifest rejects a manifest whose runtimeRange is current but runtime.version names a different major", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    const path = join(installed.root, manifestFilename);
    const manifest = JSON.parse(await readFile(path, "utf8")) as SkillManifest;
    await writeFile(path, JSON.stringify({ ...manifest, runtime: { ...manifest.runtime, version: "0.3.0" } }));

    await expect(verifySkills(options)).rejects.toThrow(/Invalid QA skill manifest/);
  });

  it("an internally-consistent manifest naming a FUTURE major is accepted (not thrown) and reported runtime-incompatible with a fact-only reason", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    const path = join(installed.root, manifestFilename);
    const manifest = JSON.parse(await readFile(path, "utf8")) as SkillManifest;
    const future = { ...manifest, sourceVersion: "2.0.0", runtimeRange: ">=2.0.0 <3.0.0", runtime: { ...manifest.runtime, version: "2.0.0" } };
    await writeFile(path, `${JSON.stringify(future, null, 2)}\n`);

    const verification = await verifySkills(options);
    expect(verification.status).toBe("runtime-incompatible");
    expect(verification.runtime?.reason).toContain(">=2.0.0 <3.0.0");
    expect(verification.runtime?.reason).toContain(runtimeCompatibility);
    // This is exactly what review round 1 caught: "predates"/"pre-1.0" is right for the 0.x case but
    // WRONG for this FUTURE-range case -- a sentence stating facts (which range, which range this build
    // verifies) must not assign a direction. "older" is still allowed to appear ON ITS OWN inside the
    // conditional clause about --force ("... if this binary is older than the one that wrote the
    // manifest") because that is the downgrade warning I3 requires, not a claim about the direction of
    // the range -- so this test does not ban that word, only "predates"/"pre-1.0".
    expect(verification.runtime?.reason?.toLowerCase()).not.toMatch(/predates|pre-1\.0/);
  });
});

/**
    // This is exactly what review round 1 caught: "predates"/"pre-1.0" is right for the 0.x case but
    // WRONG for this FUTURE-range case -- a sentence stating facts (which range, which range this build
    // verifies) must not assign a direction. "older" is still allowed to appear ON ITS OWN inside the
    // conditional clause about --force ("... if this binary is older than the one that wrote the
    // manifest") because that is the downgrade warning I3 requires, not a claim about the direction of
    // the range -- so this test does not ban that word, only "predates"/"pre-1.0".
 */
describe("C1 + I3: the runtime-incompatible reason names only a remedy that actually works", () => {
  it("names skills update --force, warns it can downgrade, and says skills install does not help", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    await ageManifestToPre1(installed.root);

    const reason = (await verifySkills(options)).runtime?.reason ?? "";
    expect(reason).toContain("skills update --force");
    expect(reason.toLowerCase()).toContain("downgrade");
    expect(reason).toContain("skills install");
    expect(reason.toLowerCase()).toMatch(/does not help|refuses to overwrite/);
  });

  it("skills install on top of an aged install really does fail -- exit 4, not the remedy the old reason text named", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    await ageManifestToPre1(installed.root);

    const result = await runCli(["skills", "install", "--agent", "codex"], { cwd: options.projectRoot });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toMatch(/Refusing to overwrite unmanaged skill file/);
  });

  it("skills update --force really does move the manifest onto the current range, and skills verify then reports valid", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    await ageManifestToPre1(installed.root);

    const forced = await runCli(["skills", "update", "--agent", "codex", "--force"], { cwd: options.projectRoot });
    expect(forced.exitCode).toBe(0);
    const verified = await runCli(["skills", "verify", "--agent", "codex"], { cwd: options.projectRoot });
    expect(verified.exitCode).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ status: "valid" });
  });
});

/**
 * I1 (review round 2): deleting `isSemverLike` (dead, correctly confirmed so in review round 2) does not
 * close I1 -- the finding does not say "there is a redundant predicate", it says "a constraint with real
 * behaviour that no mutation can kill is a constraint that is not pinned". `semverShapePattern` is
 * exactly that constraint: it still decides whether `semverMajor` returns a real major or not, but before
 * the tests below existed, no test told apart the full pattern (`^\d+\.\d+\.\d+(?:-...)?$`) from a looser
 * one that only requires the major to be numeric. The first four values are four ways a string can carry
 * a valid major while NOT being full semver: missing patch, trailing garbage, major only, and a
 * non-numeric component -- exactly the four cases the reviewer listed in review round 2, and all four pin
 * the same anchor: `$`. Re-measuring by mutation (controller, not reviewer) exposed the missing half:
 * dropping `^` ALONE left those four cases green at 69/69, because none of them carries garbage at the
 * START of the string. The fifth value, `"v1.0.0"`, closes exactly that gap -- this is not invented
 * garbage, it is the real git tag convention (`git tag v1.0.0`). Without `^`, `semverShapePattern` still
 * matches the `"1.0.0"` tail of this string and `semverMajor` still returns `"1"`, equal to the major of
 * the current `runtimeRange` -- so a 0.x manifest with a mistyped `v` (`sourceVersion: "v0.3.0"`) would
 * be ACCEPTED instead of rejected. Placed on BOTH the `sourceVersion` and `runtime.version` fields
 * because those are two separate code paths (`semverMajor(candidate.sourceVersion)` and
 * `semverMajor((runtime...).version)`), keeping the same convention I2 already used for the major
 * comparison.
 */
describe("I1: semverShapePattern must be full semver, not just \"starts with digits\"", () => {
  const malformedButMajorLooking = [
    ["1.2", "missing patch"],
    ["1.0.0x", "trailing garbage after the patch"],
    ["1", "major only, no minor/patch"],
    ["1.a.0", "non-numeric minor"],
    ["v1.0.0", "garbage at the START of the string -- the 'v' prefix of the git tag convention"],
  ] as const;

  for (const [value, why] of malformedButMajorLooking) {
    it(`readManifest rejects sourceVersion "${value}" (${why}) even though the manifest's own major appears in it`, async () => {
      const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
      const installed = await installSkills(options);
      const path = join(installed.root, manifestFilename);
      const manifest = JSON.parse(await readFile(path, "utf8")) as SkillManifest;
      await writeFile(path, JSON.stringify({ ...manifest, sourceVersion: value }));

      await expect(verifySkills(options)).rejects.toThrow(/Invalid QA skill manifest/);
    });

    it(`readManifest rejects runtime.version "${value}" (${why}) even though the manifest's own major appears in it`, async () => {
      const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
      const installed = await installSkills(options);
      const path = join(installed.root, manifestFilename);
      const manifest = JSON.parse(await readFile(path, "utf8")) as SkillManifest;
      await writeFile(path, JSON.stringify({ ...manifest, runtime: { ...manifest.runtime, version: value } }));

      await expect(verifySkills(options)).rejects.toThrow(/Invalid QA skill manifest/);
    });
  }
});

/**
 * B1 (whole-branch review, Task 7 follow-up): `rangeLowerBoundPattern` gates `runtimeRange` the same
 * way I1's `semverShapePattern` gates `sourceVersion`/`runtime.version` above, but before the cases
 * below, no test told apart the full two-comparator shape (`^>=X.Y.Z <A.B.C$`) from a pattern that only
 * checks the string STARTS `>=digits`. Measured by mutation (controller): dropping everything from the
 * required space onward left `tests/installer` green, and loosening all the way to a bare digit-capture
 * left it green too. The three values below are three ways a `runtimeRange` can start exactly right and
 * still not be this project's shape: no upper bound, a doubled separating space, and trailing
 * whitespace after the upper bound.
 */
describe("B1: rangeLowerBoundPattern must be the exact two-comparator shape, not just \"starts with >=digits\"", () => {
  const malformedButLowerBoundLooking = [
    [">=1.0.0", "missing upper bound"],
    [">=1.0.0  <2.0.0", "a doubled space between the two comparators"],
    [">=1.0.0 <2.0.0 ", "trailing whitespace after the upper bound"],
  ] as const;

  for (const [value, why] of malformedButLowerBoundLooking) {
    it(`readManifest rejects runtimeRange "${value}" (${why}) even though it starts like a real range`, async () => {
      const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
      const installed = await installSkills(options);
      const path = join(installed.root, manifestFilename);
      const manifest = JSON.parse(await readFile(path, "utf8")) as SkillManifest;
      await writeFile(path, JSON.stringify({ ...manifest, runtimeRange: value }));

      await expect(verifySkills(options)).rejects.toThrow(/Invalid QA skill manifest/);
    });
  }
});

/**
 * B2 (whole-branch review, Task 7 follow-up): two more spots in the same file with real behavior no
 * mutation caught. First, `semverShapePattern`'s prerelease group was never pinned: dropping it left
 * `tests/installer` green, even though `compatibility.test.ts` asserts
 * `isRuntimeCompatible("1.0.0-rc.1") === true`, so `createManifest` can write that exact string as
 * `sourceVersion` -- under the mutation, `readManifest` would refuse the very manifest a compatible
 * build just wrote. Second, `semverMajor`'s `typeof value === "string"` narrowing was never pinned
 * either: dropping it also left `tests/installer` green, because `semverShapePattern.exec` coerces a
 * non-string argument via `ToString` before matching, so a `sourceVersion` written as the JSON array
 * `["1.0.0"]` coerces to the string "1.0.0" and would be accepted as major "1" -- a manifest field that
 * is not even a string sneaking past shape validation.
 */
describe("B2: semverShapePattern's prerelease group, and semverMajor's typeof narrowing", () => {
  it("readManifest accepts a sourceVersion carrying a prerelease suffix, the exact shape createManifest can write when isRuntimeCompatible allows it", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    const path = join(installed.root, manifestFilename);
    const manifest = JSON.parse(await readFile(path, "utf8")) as SkillManifest;
    await writeFile(path, JSON.stringify({ ...manifest, sourceVersion: "1.0.0-rc.1" }));

    const verification = await verifySkills(options);
    expect(verification.status).toBe("valid");
  });

  it("readManifest rejects a sourceVersion given as a JSON array, even though exec would coerce it to a matching string", async () => {
    const options = { ...(await fixture()), agent: "codex" as const, target: "project" as const };
    const installed = await installSkills(options);
    const path = join(installed.root, manifestFilename);
    const manifest = JSON.parse(await readFile(path, "utf8")) as SkillManifest;
    await writeFile(path, JSON.stringify({ ...manifest, sourceVersion: ["1.0.0"] }));

    await expect(verifySkills(options)).rejects.toThrow(/Invalid QA skill manifest/);
  });
});
