import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentRoot, runRuntimeVersion } from "../../src/installer/agents.js";
import { fsyncTree } from "../../src/installer/install.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent install roots", () => {
  it("uses pure Windows path semantics for every supported agent and scope", () => {
    expect(resolveAgentRoot("codex", "project", { projectRoot: "C:\\work\\app", userHome: "C:\\Users\\qa", pathApi: path.win32 })).toBe("C:\\work\\app\\.codex\\skills");
    expect(resolveAgentRoot("claude", "user", { projectRoot: "C:\\work\\app", userHome: "C:\\Users\\qa", pathApi: path.win32 })).toBe("C:\\Users\\qa\\.claude\\skills");
    expect(resolveAgentRoot("cursor", "project", { projectRoot: "C:\\work\\app", userHome: "C:\\Users\\qa", pathApi: path.win32 })).toBe("C:\\work\\app\\.cursor\\skills");
  });

  it("uses a platform-aware fixed version invocation for Windows cmd shims", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    await expect(runRuntimeVersion("C:\\work\\node_modules\\.bin\\qa-skill.cmd", { platform: "win32", execute: async (command, args) => { calls.push({ command, args }); await Promise.resolve(); return "0.1.0\n"; } })).resolves.toBe("0.1.0\n");
    expect(calls).toEqual([{ command: "cmd.exe", args: ["/d", "/s", "/c", "\"C:\\work\\node_modules\\.bin\\qa-skill.cmd\" --version"] }]);
  });

  it("makes unsupported Windows directory open/sync failures best-effort only", async () => {
    // Use a tiny, disposable temp dir instead of process.cwd() so this test never has to
    // walk (and open+sync every file under) the whole repo tree, including node_modules.
    const root = await mkdtemp(path.join(tmpdir(), "qa-skills-fsync-"));
    roots.push(root);
    await writeFile(path.join(root, "file.txt"), "content");

    const unsupported = Object.assign(new Error("unsupported"), { code: "EPERM" });
    await expect(fsyncTree(root, { platform: "win32", openDirectory: async () => { await Promise.resolve(); throw unsupported; } })).resolves.toBeUndefined();
    await expect(fsyncTree(root, { platform: "linux", openDirectory: async () => { await Promise.resolve(); throw unsupported; } })).rejects.toThrow("unsupported");
    const isDirectory = Object.assign(new Error("directory"), { code: "EISDIR" });
    await expect(fsyncTree(root, { platform: "win32", openDirectory: async () => { await Promise.resolve(); throw isDirectory; } })).resolves.toBeUndefined();
    await expect(fsyncTree(root, { platform: "linux", openDirectory: async () => { await Promise.resolve(); throw isDirectory; } })).rejects.toThrow("directory");
  });
});
