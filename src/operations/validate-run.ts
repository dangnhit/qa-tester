import type { ArtifactProfileName } from "../core/artifact-profiles.js";
import { RunWorkspace, type WorkspaceValidation } from "../core/run-workspace.js";

export async function validateRun(root: string, runId: string, profile?: ArtifactProfileName): Promise<WorkspaceValidation> {
  const workspace = await RunWorkspace.open(root, runId);
  try {
    return await workspace.validate(profile);
  } finally {
    await workspace.close();
  }
}
