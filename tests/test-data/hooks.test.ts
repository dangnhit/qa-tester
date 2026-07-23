import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
});
