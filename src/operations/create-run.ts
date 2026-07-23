import type { ArtifactProfileName } from "../core/artifact-profiles.js";
import { RunWorkspace } from "../core/run-workspace.js";

export function createRun(options: { root: string; mode: ArtifactProfileName; environmentProfile: Record<string, unknown>; linkedRunId?: string }): Promise<RunWorkspace> {
  return RunWorkspace.create(options);
}
