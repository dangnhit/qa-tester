import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { isRuntimeCompatible, runtimeCompatibility } from "./manifest.js";
import type { RuntimeBinding } from "./manifest.js";
import { sha256Bytes } from "../core/checksum.js";

export const agentNames = ["codex", "claude", "cursor"] as const;
export const installTargets = ["project", "user"] as const;
export type AgentName = (typeof agentNames)[number];
export type InstallTarget = (typeof installTargets)[number];
export type PathApi = Pick<typeof path, "join">;

export type AgentRootOptions = Readonly<{ projectRoot: string; userHome?: string; pathApi?: PathApi }>;

const roots: Readonly<Record<AgentName, readonly [string, string]>> = {
  codex: [".codex", "skills"],
  claude: [".claude", "skills"],
  cursor: [".cursor", "skills"],
};

export function isAgentName(value: string): value is AgentName {
  return (agentNames as readonly string[]).includes(value);
}

export function isInstallTarget(value: string): value is InstallTarget {
  return (installTargets as readonly string[]).includes(value);
}

/** The install root shims live in: the project root for project scope, the user home otherwise. */
export function resolveInstallRoot(target: InstallTarget, options: AgentRootOptions): string {
  return target === "project" ? options.projectRoot : (options.userHome ?? homedir());
}

/** The copied-skills directory for an agent, relative to the install root (e.g. `.codex/skills`). */
export function agentSkillsRelativeDir(agent: AgentName): string {
  return roots[agent].join("/");
}

/** Resolve a target without touching disk, including for pure Windows-path tests. */
export function resolveAgentRoot(agent: AgentName, target: InstallTarget, options: AgentRootOptions): string {
  const pathApi = options.pathApi ?? path;
  return pathApi.join(resolveInstallRoot(target, options), ...roots[agent]);
}

export type RuntimeCommand = Readonly<{ command: string; source: "project" | "path"; version: string }>;
const runFile = promisify(execFile);
/** How a `--version` probe is spawned. `windowsVerbatimArguments` is part of the contract, not an
 *  incidental detail: the Windows `.cmd` branch is only correct when it is set (see
 *  `runRuntimeVersion`), so the seam surfaces it and the test asserts it. */
export type RuntimeSpawnOptions = Readonly<{ windowsVerbatimArguments?: boolean }>;
export type RuntimeExecutionOptions = Readonly<{
  platform?: NodeJS.Platform;
  /** Overrides `process.env.ComSpec`; supplied by tests so the expected interpreter is deterministic. */
  comSpec?: string;
  execute?: (command: string, args: readonly string[], options: RuntimeSpawnOptions) => Promise<string>;
}>;

/** The Windows command interpreter to run a `.cmd` shim through. `ComSpec` is the supported way to
 *  locate it, but an empty or absent value must still fall back — `??` alone would spawn `""`. */
export function windowsCommandInterpreter(env: Readonly<Partial<Record<string, string>>> = process.env): string {
  const comSpec = env.ComSpec ?? env.COMSPEC;
  return comSpec !== undefined && comSpec.length > 0 ? comSpec : "cmd.exe";
}

export async function captureRuntimeBinding(runtime: RuntimeCommand): Promise<RuntimeBinding> {
  const resolvedPath = await realpath(runtime.command);
  return { ...runtime, resolvedPath, sha256: sha256Bytes(await readFile(resolvedPath)) };
}

/** Prefer the project's binary; callers execute only this returned local/PATH command. */
export async function resolveCompatibleRuntime(projectRoot: string, pathValue = process.env.PATH ?? "", range = runtimeCompatibility, execution: RuntimeExecutionOptions = {}): Promise<RuntimeCommand> {
  const binary = (execution.platform ?? process.platform) === "win32" ? "qa-skill.cmd" : "qa-skill";
  const projectBinary = path.join(projectRoot, "node_modules", ".bin", binary);
  try {
    await access(projectBinary);
    return await inspectRuntime(projectBinary, "project", range, execution);
  } catch (error: unknown) {
    if (error instanceof Error && /incompatible|Unable to execute/i.test(error.message)) throw error;
  }
  for (const segment of pathValue.split(path.delimiter).filter(Boolean)) {
    try {
      const candidate = path.join(segment, binary);
      await access(candidate);
      return inspectRuntime(candidate, "path", range, execution);
    } catch {
      // Probe the next PATH entry.
    }
  }
  throw new Error("qa-skill is not installed. Install a compatible local package or add qa-skill to PATH; remote npx execution is disabled.");
}

async function inspectRuntime(command: string, source: RuntimeCommand["source"], range: string, execution: RuntimeExecutionOptions): Promise<RuntimeCommand> {
  let output: string;
  try { output = await runRuntimeVersion(command, execution); } catch { throw new Error(`Unable to execute local qa-skill at ${command}; install a compatible local runtime.`); }
  const version = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(output)?.[1];
  if (!version || !isRuntimeCompatible(version, range)) throw new Error(`Local qa-skill at ${command} has incompatible version ${version ?? "(unparseable)"}; requires ${range}.`);
  return { command, source, version };
}

/** Execute only the fixed `--version` argument; .cmd files use cmd.exe on Windows.
 *
 *  `windowsVerbatimArguments` is required, not optional polish. Without it libuv re-quotes the
 *  already-quoted `/c` payload into `"\"C:\…\qa-skill.cmd\" --version"`; `cmd /s` then strips the
 *  outer pair and tries to run a program literally named `\"C:\…\qa-skill.cmd\"`, which fails. This
 *  is the same `/d /s /c` + verbatim combination Node's own `{ shell: true }` builds on Windows.
 *  Spawning the `.cmd` directly is not an alternative: Node refuses to spawn `.cmd`/`.bat` without a
 *  shell since the CVE-2024-27980 hardening. */
export async function runRuntimeVersion(command: string, execution: RuntimeExecutionOptions = {}): Promise<string> {
  const platform = execution.platform ?? process.platform;
  if (platform === "win32" && command.toLowerCase().endsWith(".cmd")) {
    const quoted = `"${command.replaceAll('"', '""')}" --version`;
    const args = ["/d", "/s", "/c", quoted] as const;
    const interpreter = execution.comSpec ?? windowsCommandInterpreter();
    const spawnOptions = { windowsVerbatimArguments: true } as const;
    if (execution.execute) return execution.execute(interpreter, args, spawnOptions);
    return (await runFile(interpreter, args, { ...spawnOptions, encoding: "utf8" })).stdout;
  }
  const args = ["--version"] as const;
  if (execution.execute) return execution.execute(command, args, {});
  return (await runFile(command, args, { encoding: "utf8" })).stdout;
}

/** Backwards-compatible alias for callers that only need safe local resolution. */
export const resolveLocalRuntime = resolveCompatibleRuntime;
