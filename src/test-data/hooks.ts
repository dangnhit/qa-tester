import { realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { QaConfig } from "../config/load-config.js";
import { isPathWithin, type PathSemantics } from "../core/fs.js";
import { isRecord } from "../core/values.js";
import { ownedResources, type TestResource } from "./resources.js";

export type TestDataHookDescriptor =
  | Readonly<{ id: string; kind: "command"; command: readonly [string, ...string[]] }>
  | Readonly<{ id: string; kind: "api"; fixture: string }>
  | Readonly<{ id: string; kind: "module"; modulePath: string; exportName?: string }>;
export type ProducedResource = Readonly<{ id: string; cleanupAction: string }>;
export type HookRunners = Partial<Record<TestDataHookDescriptor["kind"], (descriptor: TestDataHookDescriptor, operation?: Readonly<Record<string, unknown>>) => Promise<readonly ProducedResource[]>>>;

/** Strictly inside `directory` — the directory itself is not a module target. Delegates the escape
 *  test to the shared `isPathWithin` so it is separator-aware: the previous literal `"../"` check
 *  admitted every `..\` traversal on Windows, where `path.relative` emits backslashes.
 *
 *  `pathApi` is threaded from `fromConfig` for one reason: without it this rejection is observable
 *  ONLY on Windows, `tests/test-data/` is not in the Windows job's selection, and the literal `"../"`
 *  check could be restored with the suite still green everywhere. A security check no test can fail
 *  on is a comment. */
function contained(directory: string, candidate: string, pathApi?: PathSemantics): boolean {
  return relative(directory, candidate) !== "" && isPathWithin(directory, candidate, pathApi);
}

function freezeDescriptor<T extends TestDataHookDescriptor>(descriptor: T): T {
  if (!descriptor.id) throw new Error("Test data hook ID is required");
  if (descriptor.kind === "command" && (descriptor.command.length === 0 || descriptor.command.some((part) => !part))) throw new Error("Trusted command hook must have a command array");
  if (descriptor.kind === "module" && !descriptor.modulePath) throw new Error("Trusted module hook must have a module path");
  if (descriptor.kind === "api" && !descriptor.fixture) throw new Error("Trusted API hook must have a fixture");
  return Object.freeze({ ...descriptor, ...(descriptor.kind === "command" ? { command: Object.freeze([...descriptor.command]) } : {}) }) as T;
}

/** Only configuration may construct descriptors. Testcase requests name a registered hook ID. */
export class TestDataHookRegistry {
  private readonly hooks = new Map<string, TestDataHookDescriptor>();
  public constructor(descriptors: readonly TestDataHookDescriptor[], private readonly runners: HookRunners) {
    for (const descriptor of descriptors) {
      const frozen = freezeDescriptor(descriptor);
      if (this.hooks.has(frozen.id)) throw new Error(`Test data hook ${frozen.id} is duplicated`);
      this.hooks.set(frozen.id, frozen);
    }
  }
  /** `pathApi` overrides the platform's path semantics for the containment checks below. Production
   *  callers omit it; tests pass `path.win32` to assert the Windows escape form from POSIX CI. */
  public static async fromConfig(config: Pick<QaConfig, "configDirectory" | "snapshot">, runners: HookRunners, pathApi?: PathSemantics): Promise<TestDataHookRegistry> {
    const configDirectory = await realpath(config.configDirectory);
    const hooks = config.snapshot.hooks;
    if (hooks === undefined) return new TestDataHookRegistry([], runners);
    if (!Array.isArray(hooks)) throw new Error("Config hooks must be an array of trusted descriptors");
    const descriptors = await Promise.all(hooks.map(async (hook): Promise<TestDataHookDescriptor> => {
      if (!isRecord(hook) || typeof hook.id !== "string" || typeof hook.kind !== "string") throw new Error("Config hook descriptor is invalid");
      if (hook.kind === "command" && typeof hook.command === "string" && Array.isArray(hook.args) && hook.args.every((arg) => typeof arg === "string")) {
        return { id: hook.id, kind: "command", command: [hook.command, ...hook.args] };
      }
      if (hook.kind === "api" && typeof hook.fixture === "string") return { id: hook.id, kind: "api", fixture: hook.fixture };
      if (hook.kind === "module" && typeof hook.modulePath === "string" && (hook.exportName === undefined || typeof hook.exportName === "string")) {
        const candidate = resolve(configDirectory, hook.modulePath);
        if (!contained(configDirectory, candidate, pathApi)) throw new Error("Configured module hook path must remain contained by the config directory");
        if (!(await stat(candidate)).isFile()) throw new Error("Configured module hook target must be a file");
        const modulePath = await realpath(candidate);
        if (!contained(configDirectory, modulePath, pathApi)) throw new Error("Configured module hook symlink escapes the config directory");
        return { id: hook.id, kind: "module", modulePath, ...(typeof hook.exportName === "string" ? { exportName: hook.exportName } : {}) };
      }
      throw new Error("Config hook descriptor is invalid");
    }));
    return new TestDataHookRegistry(descriptors, runners);
  }
  public async execute(input: Readonly<{ hookId: string; ownerRunId: string }>): Promise<readonly TestResource[]> {
    if (Object.keys(input).some((key) => key !== "hookId" && key !== "ownerRunId")) throw new Error("Testcases may supply only hookId, not untrusted hook commands or module paths");
    return this.executeTrusted(input.hookId, input.ownerRunId);
  }
  public executeTrusted(hookId: string, ownerRunId: string, operation?: Readonly<Record<string, unknown>>): Promise<readonly TestResource[]> {
    const descriptor = this.hooks.get(hookId);
    if (!descriptor) throw new Error(`Unknown trusted test data hook ${hookId}`);
    const runner = this.runners[descriptor.kind];
    if (!runner) throw new Error(`Trusted test data hook ${hookId} has no runtime runner`);
    return runner(descriptor, operation).then((resources) => ownedResources(ownerRunId, resources));
  }
}
