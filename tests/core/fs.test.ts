import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isPathWithin, isRealPathWithin, manifestRelativePath } from "../../src/core/fs.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("manifestRelativePath", () => {
  // The manifest records `inputs/<id>-<type>.json` on EVERY platform, so the orphan-file scan in
  // `inspectWorkspaceState` — which derives its paths from the filesystem — must produce the same
  // canonical form. `pathApi` is the injection seam that makes the Windows behaviour observable from
  // POSIX CI, so this regression cannot silently rot until somebody looks at the Windows job again.
  it("converts a Windows-native relative path to the manifest's canonical POSIX form", () => {
    expect(manifestRelativePath("C:\\ws\\run", "C:\\ws\\run\\inputs\\01K-test-case.json", path.win32))
      .toBe("inputs/01K-test-case.json");
    expect(manifestRelativePath("C:\\ws\\run", "C:\\ws\\run\\evidence\\01K-shot.png", path.win32))
      .toBe("evidence/01K-shot.png");
  });

  it("leaves an already-POSIX relative path untouched", () => {
    expect(manifestRelativePath("/ws/run", "/ws/run/inputs/01K-test-case.json", path.posix))
      .toBe("inputs/01K-test-case.json");
  });

  it("keeps a backslash inside a POSIX filename, which is a legal name character there", () => {
    // Splitting on `[\\/]` rather than on the platform separator would corrupt this name.
    expect(manifestRelativePath("/ws/run", "/ws/run/inputs/od\\d.json", path.posix)).toBe("inputs/od\\d.json");
  });

  it("returns the manifest form for a real file under a real workspace directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-skills-fs-"));
    roots.push(root);
    await mkdir(join(root, "inputs"), { recursive: true });
    await writeFile(join(root, "inputs", "artifact.json"), "{}\n");
    expect(manifestRelativePath(root, join(root, "inputs", "artifact.json"))).toBe("inputs/artifact.json");
  });
});

describe("isPathWithin", () => {
  it("admits the root itself and anything under it, on both platform semantics", () => {
    expect(isPathWithin("/ws", "/ws", path.posix)).toBe(true);
    expect(isPathWithin("/ws", "/ws/inputs/a.json", path.posix)).toBe(true);
    expect(isPathWithin("C:\\ws", "C:\\ws", path.win32)).toBe(true);
    expect(isPathWithin("C:\\ws", "C:\\ws\\inputs\\a.json", path.win32)).toBe(true);
  });

  // The Windows escape marker is `..\`, so a containment check written against the literal `"../"`
  // returns true for every traversal there. This is the case only Windows can produce natively.
  it("rejects a Windows `..\\` traversal, which a literal `../` check would admit", () => {
    expect(isPathWithin("C:\\ws\\run", "C:\\ws\\other", path.win32)).toBe(false);
    expect(isPathWithin("C:\\ws\\run", "C:\\ws", path.win32)).toBe(false);
    expect(isPathWithin("/ws/run", "/ws/other", path.posix)).toBe(false);
    expect(isPathWithin("/ws/run", "/ws", path.posix)).toBe(false);
  });

  it("rejects a candidate on another Windows drive, which relative-izes to an absolute path", () => {
    expect(isPathWithin("C:\\ws", "D:\\elsewhere\\a.json", path.win32)).toBe(false);
  });
});

describe("isRealPathWithin", () => {
  /** A root, and a sibling directory outside it, both realpath'd — `mkdtemp` hands back
   *  `/var/folders/...` on macOS while the same directory realpaths to `/private/var/folders/...`, and
   *  a containment predicate that compared the two raw strings would answer this suite's questions
   *  wrongly for reasons that have nothing to do with what it is being asked. */
  async function dirs(): Promise<{ root: string; outside: string }> {
    const base = await mkdtemp(join(tmpdir(), "qa-skills-real-"));
    roots.push(base);
    const root = join(base, "root");
    const outside = join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    return { root, outside };
  }

  it("answers true for a path inside the root and false for one outside it", async () => {
    const { root, outside } = await dirs();
    expect(await isRealPathWithin(root, join(root, "nested", "file.json"))).toBe(true);
    expect(await isRealPathWithin(root, join(outside, "file.json"))).toBe(false);
  });

  it("answers true for the root itself", async () => {
    const { root } = await dirs();
    expect(await isRealPathWithin(root, root)).toBe(true);
  });

  // The property `assertPathWithin` already has and a `realpath(dirname(candidate))` written by hand
  // does not: the candidate's OWN inode is resolved, so a symlink at the leaf is followed to where a
  // write through it would actually land rather than judged by the innocent directory holding it.
  it("follows a symlink AT THE LEAF into the root, which resolving only the parent would miss", async () => {
    const { root, outside } = await dirs();
    await writeFile(join(root, "target.json"), "{}");
    const link = join(outside, "looks-innocent.json");
    await symlink(join(root, "target.json"), link);

    expect(await isRealPathWithin(root, link)).toBe(true);
    expect(isPathWithin(root, link)).toBe(false);
  });

  it("follows a symlinked PARENT directory into the root", async () => {
    const { root, outside } = await dirs();
    const link = join(outside, "linked-dir");
    await symlink(root, link);

    expect(await isRealPathWithin(root, join(link, "not-created-yet.json"))).toBe(true);
  });

  // Deliberate, and shared with `assertPathWithin`: an unresolvable candidate throws rather than
  // answering `false`, because `false` would wave a caller through to a target the link would create.
  it("throws rather than answering false for a dangling symlink", async () => {
    const { root, outside } = await dirs();
    const link = join(outside, "dangling.json");
    await symlink(join(root, "never-created.json"), link);

    await expect(isRealPathWithin(root, link)).rejects.toThrow(/ENOENT/);
  });
});
