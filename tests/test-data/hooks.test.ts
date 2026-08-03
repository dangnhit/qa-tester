import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import path, { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TestDataHookRegistry } from "../../src/test-data/hooks.js";

describe("TestDataHookRegistry", () => {
  it("executes only a pre-registered descriptor selected by hook ID", async () => {
    const calls: unknown[] = [];
    const hooks = new TestDataHookRegistry([{ id: "seed-user", kind: "command", command: ["node", "scripts/seed-user.mjs"] }], {
      command: (descriptor) => { calls.push(descriptor); return Promise.resolve([{ id: "user-1", cleanupAction: "delete-user" }]); },
    });

    await expect(hooks.execute({ hookId: "seed-user", ownerRunId: "run-1" })).resolves.toEqual([{ id: "user-1", ownerRunId: "run-1", cleanupAction: "delete-user" }]);
    await expect(hooks.execute({ hookId: "seed-user", ownerRunId: "run-1", command: ["rm", "-rf", "/"] } as never)).rejects.toThrow(/only hookId|untrusted/i);
    expect(calls).toHaveLength(1);
  });

  it("realpath-validates module hooks and rejects contained symlink paths that escape", async () => {
    const root = await mkdtemp("/tmp/qa-hooks-");
    await mkdir(join(root, "hooks"));
    await writeFile(join(root, "hooks", "seed.mjs"), "export default {};\n");
    const registry = await TestDataHookRegistry.fromConfig({ configDirectory: root, snapshot: { version: 1, hooks: [{ id: "module", kind: "module", modulePath: "hooks/seed.mjs" }] } }, { module: () => Promise.resolve([]) });
    expect(registry).toBeInstanceOf(TestDataHookRegistry);
    const outside = await mkdtemp("/tmp/qa-hook-outside-");
    await writeFile(join(outside, "escape.mjs"), "export default {};\n");
    await symlink(join(outside, "escape.mjs"), join(root, "hooks", "escape.mjs"));
    await expect(TestDataHookRegistry.fromConfig({ configDirectory: root, snapshot: { version: 1, hooks: [{ id: "escape", kind: "module", modulePath: "hooks/escape.mjs" }] } }, { module: () => Promise.resolve([]) })).rejects.toThrow(/contain|path|symlink/i);
  });

  // Windows semantics, asserted from POSIX, and specifically shaped to be REVERT-PROOF against the
  // pre-branch body (`git show a00e23b:src/test-data/hooks.ts`: native `relative`, literal `"../"`,
  // no seam). A candidate built from `../escape.mjs` does NOT discriminate: native `relative` inside
  // `contained` renders it `../escape.mjs`, which the literal check already rejects, so that assertion
  // only re-pins `isPathWithin`'s `..${sep}` marker — which `tests/core/fs.test.ts` pins directly.
  //
  // The discriminating fixture is a real file named literally `..\escape.mjs` INSIDE `<root>/hooks`.
  // Backslash is a legal POSIX filename character, so natively that is one ordinary segment and the
  // literal check ADMITS it; under win32 algebra the same string is a traversal out of the config
  // directory and is REJECTED. That is exactly the Windows hazard: the identical configured string
  // escapes on Windows and does not on POSIX. The fixture requires a backslash in a filename and so
  // is POSIX-only by construction, matching this file's existing hardcoded `/tmp/` convention.
  it("rejects a traversal expressed with Windows separators, which a literal `../` check admits", async () => {
    const root = await mkdtemp("/tmp/qa-hooks-win-");
    await mkdir(join(root, "hooks"));
    await writeFile(join(root, "hooks", "seed.mjs"), "export default {};\n");

    // Sanity: under win32 algebra a contained module still resolves as contained, so a rejection
    // below is the traversal being caught rather than the seam rejecting everything.
    await expect(TestDataHookRegistry.fromConfig(
      { configDirectory: root, snapshot: { version: 1, hooks: [{ id: "module", kind: "module", modulePath: "hooks/seed.mjs" }] } },
      { module: () => Promise.resolve([]) },
      path.win32,
    )).resolves.toBeInstanceOf(TestDataHookRegistry);

    // The file really exists and really is a file, so with the pre-branch body every later gate
    // (`stat`, `realpath`, the second `contained`) also passes and `fromConfig` RESOLVES — the
    // traversal admitted outright, which is the unambiguous red.
    await writeFile(join(root, "hooks", "..\\escape.mjs"), "export default {};\n");
    await expect(TestDataHookRegistry.fromConfig(
      { configDirectory: join(root, "hooks"), snapshot: { version: 1, hooks: [{ id: "escape", kind: "module", modulePath: "..\\escape.mjs" }] } },
      { module: () => Promise.resolve([]) },
      path.win32,
    )).rejects.toThrow(/must remain contained by the config directory/i);
  });
});
