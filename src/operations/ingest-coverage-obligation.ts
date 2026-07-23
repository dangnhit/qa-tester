import { validateArtifact } from "../contracts/validator.js";
import { QaSkillsError } from "../core/errors.js";
import { RunWorkspace } from "../core/run-workspace.js";
import { readAgentDraft, type RegisteredPlanningArtifact } from "./ingest-requirement-analysis.js";

export async function ingestCoverageObligation(options: {
  root: string;
  runId: string;
  sourcePath: string;
  relationships?: string[];
}): Promise<RegisteredPlanningArtifact> {
  const draft = await readAgentDraft(options.sourcePath);
  if (!validateArtifact("coverage-obligation", draft).valid) {
    throw new QaSkillsError("Coverage Obligation Agent Draft does not satisfy the artifact contract", "INVALID_ARTIFACT");
  }
  const workspace = await RunWorkspace.open(options.root, options.runId);
  try {
    return await workspace.registerArtifactValue({
      type: "coverage-obligation",
      value: draft,
      relationships: options.relationships ?? [],
      provenance: "agent-draft",
    });
  } finally {
    await workspace.close();
  }
}
