import { access } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { isRuntimeCompatible, runtimeCompatibility } from "./manifest.js";

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

/** Resolve a target without touching disk, including for pure Windows-path tests. */
export function resolveAgentRoot(agent: AgentName, target: InstallTarget, options: AgentRootOptions): string {
  const pathApi = options.pathApi ?? path;
  const base = target === "project" ? options.projectRoot : (options.userHome ?? homedir());
  return pathApi.join(base, ...roots[agent]);
}

export type RuntimeCommand = Readonly<{ command: string; source: "project" | "path"; version: string }>;
const runFile = promisify(execFile);

/** Prefer the project's binary; callers execute only this returned local/PATH command. */
export async function resolveCompatibleRuntime(projectRoot: string, pathValue = process.env.PATH ?? "", range = runtimeCompatibility): Promise<RuntimeCommand> {
  const binary = process.platform === "win32" ? "qa-skill.cmd" : "qa-skill";
  const projectBinary = path.join(projectRoot, "node_modules", ".bin", binary);
  try {
    await access(projectBinary);
    return inspectRuntime(projectBinary, "project", range);
  } catch {
    // Continue with PATH, never a package-fetching fallback.
  }
  for (const segment of pathValue.split(path.delimiter).filter(Boolean)) {
    try {
      const candidate = path.join(segment, binary);
      await access(candidate);
      return inspectRuntime(candidate, "path", range);
    } catch {
      // Probe the next PATH entry.
    }
  }
  throw new Error("qa-skill is not installed. Install a compatible local package or add qa-skill to PATH; remote npx execution is disabled.");
}

async function inspectRuntime(command: string, source: RuntimeCommand["source"], range: string): Promise<RuntimeCommand> {
  let output: string;
  try { output = (await runFile(command, ["--version"], { encoding: "utf8" })).stdout; } catch { throw new Error(`Unable to execute local qa-skill at ${command}; install a compatible local runtime.`); }
  const version = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(output)?.[1];
  if (!version || !isRuntimeCompatible(version, range)) throw new Error(`Local qa-skill at ${command} has incompatible version ${version ?? "(unparseable)"}; requires ${range}.`);
  return { command, source, version };
}

/** Backwards-compatible alias for callers that only need safe local resolution. */
export const resolveLocalRuntime = resolveCompatibleRuntime;
