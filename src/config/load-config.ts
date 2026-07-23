import { access, readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

import { parseAuthoringDocument } from "../contracts/authoring.js";

export type QaConfig = Readonly<{
  configPath?: string;
  configDirectory: string;
  artifactDirectory: string;
  snapshot: Readonly<Record<string, unknown>>;
}>;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => { freeze(item); });
    Object.freeze(value);
  }
  return value;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function repositoryRoot(cwd: string): Promise<string> {
  let current = cwd;
  while (true) {
    if (await exists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

async function discover(cwd: string): Promise<string | undefined> {
  const root = await repositoryRoot(cwd);
  let current = cwd;
  while (true) {
    for (const filename of ["qa.config.yaml", "qa.config.yml", "qa.config.json"]) {
      const candidate = join(current, filename);
      if (await exists(candidate)) return candidate;
    }
    if (current === root) return undefined;
    current = dirname(current);
  }
}

function configFormat(path: string): "json" | "yaml" {
  const extension = extname(path).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".yaml" || extension === ".yml") return "yaml";
  throw new Error("QA configuration must be declarative JSON or YAML; executable TypeScript is not supported");
}

export async function loadQaConfig(options: { cwd?: string; configPath?: string } = {}): Promise<QaConfig> {
  const cwd = await realpath(options.cwd ?? process.cwd());
  const selected = options.configPath === undefined
    ? await discover(cwd)
    : resolve(cwd, isAbsolute(options.configPath) ? options.configPath : options.configPath);
  if (selected === undefined) return freeze({ configDirectory: cwd, artifactDirectory: join(cwd, "qa-results"), snapshot: { version: 1 } });
  if (!(await exists(selected))) throw new Error(`QA configuration does not exist: ${selected}`);
  const configPath = await realpath(selected);
  const parsed = parseAuthoringDocument(await readFile(configPath, "utf8"), configFormat(configPath));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as Record<string, unknown>).version !== 1) throw new Error("QA configuration must be a declarative version 1 object");
  const snapshot = freeze(JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>);
  const configDirectory = dirname(configPath);
  const configuredDirectory = typeof snapshot.artifactDirectory === "string" ? snapshot.artifactDirectory : "qa-results";
  return freeze({ configPath, configDirectory, artifactDirectory: resolve(configDirectory, configuredDirectory), snapshot });
}
