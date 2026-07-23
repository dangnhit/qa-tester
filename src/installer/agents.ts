import { access } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

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

export type RuntimeCommand = Readonly<{ command: string; source: "project" | "path" }>;

/** Prefer the project's binary; callers execute only this returned local/PATH command. */
export async function resolveLocalRuntime(projectRoot: string, pathValue = process.env.PATH ?? ""): Promise<RuntimeCommand> {
  const binary = process.platform === "win32" ? "qa-skill.cmd" : "qa-skill";
  const projectBinary = path.join(projectRoot, "node_modules", ".bin", binary);
  try {
    await access(projectBinary);
    return { command: projectBinary, source: "project" };
  } catch {
    // Continue with PATH, never a package-fetching fallback.
  }
  for (const segment of pathValue.split(path.delimiter).filter(Boolean)) {
    try {
      await access(path.join(segment, binary));
      return { command: "qa-skill", source: "path" };
    } catch {
      // Probe the next PATH entry.
    }
  }
  throw new Error("qa-skill is not installed. Install this package locally or add qa-skill to PATH; remote npx execution is disabled.");
}
