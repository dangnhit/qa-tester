import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A stand-in for the `qa-skill` binary npm links into `node_modules/.bin`.
 *
 * npm writes that bin as `qa-skill.cmd` (plus `.ps1`) on Windows and as an extensionless shell
 * script elsewhere, and `resolveCompatibleRuntime` probes for exactly the one its platform can
 * execute. The installer fixtures used to hard-code the `#!/bin/sh` script on every platform, so on
 * Windows they staged a runtime the OS can never run: all 26 installer lifecycle and shim tests
 * failed with "qa-skill is not installed" before touching their own subject.
 *
 * This helper writes the runtime the CURRENT platform would really have, and returns its path so
 * callers assert against the same file the installer resolves.
 */
export const runtimeBinaryName = process.platform === "win32" ? "qa-skill.cmd" : "qa-skill";

export function runtimePath(binDirectory: string): string {
  return join(binDirectory, runtimeBinaryName);
}

export function projectRuntimePath(projectRoot: string): string {
  return runtimePath(join(projectRoot, "node_modules", ".bin"));
}

/**
 * Writes a runtime whose `--version` prints `output`. `marker` adds a platform-appropriate comment
 * line, which changes the file's bytes — and therefore its recorded sha256 — while leaving the
 * reported version alone, so `verify` can be driven to `runtime-changed` rather than
 * `runtime-incompatible`.
 */
export async function writeRuntime(binDirectory: string, output = "1.0.0", marker?: string): Promise<string> {
  const path = runtimePath(binDirectory);
  const body = process.platform === "win32"
    ? `@echo off\r\n${marker === undefined ? "" : `rem ${marker}\r\n`}echo ${output}\r\n`
    : `#!/bin/sh\n${marker === undefined ? "" : `# ${marker}\n`}echo ${output}\n`;
  await writeFile(path, body);
  if (process.platform !== "win32") await chmod(path, 0o755);
  return path;
}

/** Creates `<projectRoot>/node_modules/.bin` and writes the platform's runtime into it. */
export async function writeProjectRuntime(projectRoot: string, output = "1.0.0", marker?: string): Promise<string> {
  const binDirectory = join(projectRoot, "node_modules", ".bin");
  await mkdir(binDirectory, { recursive: true });
  return writeRuntime(binDirectory, output, marker);
}
