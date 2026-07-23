import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentRoot, runRuntimeVersion } from "../../src/installer/agents.js";
import { fsyncTree } from "../../src/installer/install.js";

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
    const unsupported = Object.assign(new Error("unsupported"), { code: "EPERM" });
    await expect(fsyncTree(process.cwd(), { platform: "win32", openDirectory: async () => { await Promise.resolve(); throw unsupported; } })).resolves.toBeUndefined();
    await expect(fsyncTree(process.cwd(), { platform: "linux", openDirectory: async () => { await Promise.resolve(); throw unsupported; } })).rejects.toThrow("unsupported");
  });
});
