import { ownedResources, type TestResource } from "./resources.js";

export type TestDataHookDescriptor =
  | Readonly<{ id: string; kind: "command"; command: readonly [string, ...string[]] }>
  | Readonly<{ id: string; kind: "api"; fixture: string }>
  | Readonly<{ id: string; kind: "module"; modulePath: string; exportName?: string }>;
type ProducedResource = Readonly<{ id: string; cleanupAction: string }>;
type HookRunners = Partial<Record<TestDataHookDescriptor["kind"], (descriptor: TestDataHookDescriptor) => Promise<readonly ProducedResource[]>>>;

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
  public async execute(input: Readonly<{ hookId: string; ownerRunId: string }>): Promise<readonly TestResource[]> {
    if (Object.keys(input).some((key) => key !== "hookId" && key !== "ownerRunId")) throw new Error("Testcases may supply only hookId, not untrusted hook commands or module paths");
    const descriptor = this.hooks.get(input.hookId);
    if (!descriptor) throw new Error(`Unknown trusted test data hook ${input.hookId}`);
    const runner = this.runners[descriptor.kind];
    if (!runner) throw new Error(`Trusted test data hook ${input.hookId} has no runtime runner`);
    return ownedResources(input.ownerRunId, await runner(descriptor));
  }
}
