import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentRoot, resolveCompatibleRuntime, runRuntimeVersion, windowsCommandInterpreter } from "../../src/installer/agents.js";
import type { RuntimeSpawnOptions } from "../../src/installer/agents.js";
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
    const calls: Array<{ command: string; args: readonly string[]; options: RuntimeSpawnOptions }> = [];
    // `comSpec` is supplied rather than left to `process.env.ComSpec`, which on a real Windows host
    // is the absolute `C:\Windows\system32\cmd.exe` and made this assertion unsatisfiable there.
    // `windowsVerbatimArguments` is asserted because the quoted `/c` payload is only correct with it.
    await expect(runRuntimeVersion("C:\\work\\node_modules\\.bin\\qa-skill.cmd", {
      platform: "win32",
      comSpec: "cmd.exe",
      execute: async (command, args, options) => { calls.push({ command, args, options }); await Promise.resolve(); return "1.0.0\n"; },
    })).resolves.toBe("1.0.0\n");
    expect(calls).toEqual([{
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "\"C:\\work\\node_modules\\.bin\\qa-skill.cmd\" --version"],
      options: { windowsVerbatimArguments: true },
    }]);
  });

  // Node has refused to spawn EITHER extension directly since the CVE-2024-27980 hardening (see
  // `runRuntimeVersion`'s own doc comment), so `.bat` must be routed through cmd.exe exactly like
  // `.cmd` — this mirrors the `.cmd` case above with only the extension and expected argv changed.
  it("uses the same cmd.exe routing for a .bat shim as for .cmd, since Node refuses to spawn either directly", async () => {
    const calls: Array<{ command: string; args: readonly string[]; options: RuntimeSpawnOptions }> = [];
    await expect(runRuntimeVersion("C:\\work\\node_modules\\.bin\\qa-skill.bat", {
      platform: "win32",
      comSpec: "cmd.exe",
      execute: async (command, args, options) => { calls.push({ command, args, options }); await Promise.resolve(); return "1.0.0\n"; },
    })).resolves.toBe("1.0.0\n");
    expect(calls).toEqual([{
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "\"C:\\work\\node_modules\\.bin\\qa-skill.bat\" --version"],
      options: { windowsVerbatimArguments: true },
    }]);
  });

  it("spawns a non-cmd runtime directly, with no interpreter and no verbatim quoting", async () => {
    const calls: Array<{ command: string; args: readonly string[]; options: RuntimeSpawnOptions }> = [];
    await expect(runRuntimeVersion("/work/node_modules/.bin/qa-skill", {
      platform: "linux",
      execute: async (command, args, options) => { calls.push({ command, args, options }); await Promise.resolve(); return "1.0.0\n"; },
    })).resolves.toBe("1.0.0\n");
    expect(calls).toEqual([{ command: "/work/node_modules/.bin/qa-skill", args: ["--version"], options: {} }]);
  });

  it("falls back to cmd.exe when ComSpec is absent or blank, and honours it otherwise", () => {
    expect(windowsCommandInterpreter({})).toBe("cmd.exe");
    expect(windowsCommandInterpreter({ ComSpec: "" })).toBe("cmd.exe");
    expect(windowsCommandInterpreter({ ComSpec: "C:\\Windows\\system32\\cmd.exe" })).toBe("C:\\Windows\\system32\\cmd.exe");
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

  it("opens files for write before flushing them, because a Windows read handle cannot be flushed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qa-skills-fsync-file-"));
    roots.push(root);
    await writeFile(path.join(root, "file.txt"), "content");

    const flags: string[] = [];
    await fsyncTree(root, { openFile: async (target, flag) => { flags.push(flag); return open(target, flag); } });
    expect(flags).toEqual(["r+"]);
  });

  it("falls back to a read handle when a file cannot be opened for write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qa-skills-fsync-ro-"));
    roots.push(root);
    await writeFile(path.join(root, "file.txt"), "content");

    const flags: string[] = [];
    await fsyncTree(root, {
      openFile: async (target, flag) => {
        flags.push(flag);
        if (flag === "r+") throw Object.assign(new Error("read-only"), { code: "EACCES" });
        return open(target, flag);
      },
    });
    expect(flags).toEqual(["r+", "r"]);
  });

  // The real Windows failure: `FlushFileBuffers` on a read handle returns EPERM, so `fsyncTree(stage)`
  // threw on EVERY Windows install, not only under a fault injector.
  it("makes an unsupported Windows file flush best-effort, and still fails elsewhere", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qa-skills-fsync-eperm-"));
    roots.push(root);
    await writeFile(path.join(root, "file.txt"), "content");

    const unflushable = { sync: () => Promise.reject(Object.assign(new Error("cannot flush"), { code: "EPERM" })), close: () => Promise.resolve() };
    await expect(fsyncTree(root, { platform: "win32", openFile: () => Promise.resolve(unflushable), openDirectory: () => Promise.resolve(unflushable) })).resolves.toBeUndefined();
    await expect(fsyncTree(root, { platform: "linux", openFile: () => Promise.resolve(unflushable) })).rejects.toThrow("cannot flush");
  });
});

describe("resolveCompatibleRuntime PATHEXT probing", () => {
  // `resolveCompatibleRuntime` has no injectable `pathApi` like `resolveAgentRoot` does: `path.join` and
  // `path.delimiter` inside it are always the REAL `node:path` for the host running the test, regardless
  // of `execution.platform`. So these cases write real files at real host-flavoured paths and assert
  // against paths built the same way (never a literal `C:\...` string, which a POSIX test host could
  // not produce) — `execution.platform: "win32"` only selects WHICH candidate filenames get probed.
  it("probes qa-skill.exe in the project's bin directory when qa-skill.cmd is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qa-skills-pathext-project-"));
    roots.push(root);
    const binDirectory = path.join(root, "node_modules", ".bin");
    await mkdir(binDirectory, { recursive: true });
    const exePath = path.join(binDirectory, "qa-skill.exe");
    await writeFile(exePath, "not a real binary");

    const resolved = await resolveCompatibleRuntime(root, "", undefined, { platform: "win32", execute: async () => { await Promise.resolve(); return "1.0.0\n"; } });
    expect(resolved).toEqual({ command: exePath, source: "project", version: "1.0.0" });
  });

  it("falls back to a PATH qa-skill.bat shim on win32 when the project has none of the candidate names", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qa-skills-pathext-path-"));
    roots.push(root);
    const emptyPathDir = path.join(root, "empty-on-path");
    const batDir = path.join(root, "bat-on-path");
    await mkdir(emptyPathDir, { recursive: true });
    await mkdir(batDir, { recursive: true });
    const batPath = path.join(batDir, "qa-skill.bat");
    await writeFile(batPath, "not a real binary");
    // Joined with the real `path.delimiter` (`:` on this host), matching how `resolveCompatibleRuntime`
    // splits it — a literal `;` would silently produce one unsplit segment on POSIX.
    const pathValue = [emptyPathDir, batDir].join(path.delimiter);

    const resolved = await resolveCompatibleRuntime(root, pathValue, undefined, { platform: "win32", execute: async () => { await Promise.resolve(); return "1.2.0\n"; } });
    expect(resolved).toEqual({ command: batPath, source: "path", version: "1.2.0" });
  });

  it("aborts on an incompatible project qa-skill.exe rather than trying qa-skill.bat in the same directory or PATH", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qa-skills-pathext-abort-"));
    roots.push(root);
    const binDirectory = path.join(root, "node_modules", ".bin");
    await mkdir(binDirectory, { recursive: true });
    const exePath = path.join(binDirectory, "qa-skill.exe");
    // A LATER candidate in the same directory, and on PATH too. The stub reports every command as
    // version 9.0.0 — incompatible with the `>=1.0.0 <2.0.0` range regardless of which candidate runs
    // it — so satisfying the range is not what this proves. What proves the abort is `calls` staying at
    // exactly one entry: the later candidates are never even attempted, which only an abort (rather than
    // a continued probe that also happens to fail) explains. Note "9.0.0" is rejected by the same regex
    // clause as any 0.x version now, so this case no longer distinguishes "an unfamiliar future version"
    // from "our own superseded 0.x line" — see the same note in lifecycle.test.ts.
    await writeFile(exePath, "not a real binary");
    await writeFile(path.join(binDirectory, "qa-skill.bat"), "not a real binary");
    const pathDir = path.join(root, "on-path");
    await mkdir(pathDir, { recursive: true });
    await writeFile(path.join(pathDir, "qa-skill.bat"), "not a real binary");

    const calls: string[] = [];
    await expect(resolveCompatibleRuntime(root, pathDir, undefined, {
      platform: "win32",
      execute: async (command) => { calls.push(command); await Promise.resolve(); return "9.0.0\n"; },
    })).rejects.toThrow(/incompatible/i);
    expect(calls).toEqual([exePath]);
  });

  // Regression proof: before `runRuntimeVersion` routed `.bat` through cmd.exe, a project bin holding
  // ONLY a `.bat` (found by the widened probe, but then unable to execute per the CVE-2024-27980
  // hardening) would abort here rather than falling through to this same PATH `.cmd` — which used to
  // resolve just fine before PATHEXT probing existed at all. Asserting on the injected `execute` call's
  // shape (not merely that the promise resolves) is load-bearing: a mock that ignores its arguments
  // would "succeed" via either routing branch and could not tell a shell-routed call from a direct one.
  it("resolves a project qa-skill.bat by routing it through cmd.exe, in preference to a working PATH qa-skill.cmd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qa-skills-pathext-bat-route-"));
    roots.push(root);
    const binDirectory = path.join(root, "node_modules", ".bin");
    await mkdir(binDirectory, { recursive: true });
    const batPath = path.join(binDirectory, "qa-skill.bat");
    await writeFile(batPath, "not a real binary");
    const pathDir = path.join(root, "on-path");
    await mkdir(pathDir, { recursive: true });
    await writeFile(path.join(pathDir, "qa-skill.cmd"), "not a real binary");

    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const resolved = await resolveCompatibleRuntime(root, pathDir, undefined, {
      platform: "win32",
      comSpec: "cmd.exe",
      execute: async (command, args) => { calls.push({ command, args }); await Promise.resolve(); return "1.0.0\n"; },
    });

    expect(resolved).toEqual({ command: batPath, source: "project", version: "1.0.0" });
    // The interpreter, not the .bat path, is the "command" `execute` receives — the direct-spawn branch
    // would instead have passed `batPath` itself with a bare `["--version"]`, which is exactly what a
    // real Windows host refuses for a `.bat` without a shell.
    expect(calls).toEqual([{ command: "cmd.exe", args: ["/d", "/s", "/c", `"${batPath}" --version`] }]);
  });
});
