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

  it("constructs trusted descriptors only from a strict config snapshot and contains module paths", () => {
    const registry = TestDataHookRegistry.fromConfig({ configDirectory: "/repo/config", snapshot: { version: 1, hooks: [{ id: "module", kind: "module", modulePath: "hooks/seed.mjs" }] } }, { module: () => Promise.resolve([]) });
    expect(registry).toBeInstanceOf(TestDataHookRegistry);
    expect(() => TestDataHookRegistry.fromConfig({ configDirectory: "/repo/config", snapshot: { version: 1, hooks: [{ id: "escape", kind: "module", modulePath: "../escape.mjs" }] } }, { module: () => Promise.resolve([]) })).toThrow(/contain|path/i);
  });
});
