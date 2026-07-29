import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isPathWithin, manifestRelativePath } from "../../src/core/fs.js";

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
