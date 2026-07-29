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

  // Windows semantics, asserted from POSIX. The containment check's escape marker is `..${sep}`, and
  // the literal `"../"` this replaced returned `contained === true` for every `..\` traversal — the
  // check did nothing at all on Windows. That is observable nowhere else: `tests/test-data/` is not
  // in the Windows job's selection, so without injecting the semantics the literal check could be
  // restored with CI green. Real POSIX directories are used for the filesystem calls; only the path
  // ALGEBRA is win32, which is precisely the part that differed.
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

    // `../escape.mjs` out of `<root>/hooks` relative-izes to `..\escape.mjs` under win32 algebra.
    // The literal `"../"` check returns contained === true for that string, so this rejection is the
    // one assertion in the suite that fails if the separator-aware check is reverted. Containment is
    // decided before `stat`, so the target need not exist.
    await writeFile(join(root, "escape.mjs"), "export default {};\n");
    await expect(TestDataHookRegistry.fromConfig(
      { configDirectory: join(root, "hooks"), snapshot: { version: 1, hooks: [{ id: "escape", kind: "module", modulePath: "../escape.mjs" }] } },
      { module: () => Promise.resolve([]) },
      path.win32,
    )).rejects.toThrow(/must remain contained by the config directory/i);
  });
});
