import { readFile } from "node:fs/promises";

import { parseAuthoringDocument } from "../contracts/authoring.js";
import { formatValidationErrors, validateArtifact } from "../contracts/validator.js";
import { QaSkillsError } from "../core/errors.js";
import { RunWorkspace, type ArtifactRecord } from "../core/run-workspace.js";
import { assertRequirementAuthorities } from "../planning/authority.js";

export type IngestRequirementAnalysisOptions = {
  root: string;
  runId: string;
  sourcePath: string;
  relationships?: string[];
};

export type RegisteredPlanningArtifact = ArtifactRecord & { absolutePath: string };

function formatFor(sourcePath: string): "json" | "yaml" {
  return sourcePath.endsWith(".yaml") || sourcePath.endsWith(".yml") ? "yaml" : "json";
}

export async function readAgentDraft(sourcePath: string): Promise<unknown> {
  return parseAuthoringDocument(await readFile(sourcePath, "utf8"), formatFor(sourcePath));
}

export async function ingestRequirementAnalysis(
  options: IngestRequirementAnalysisOptions,
): Promise<RegisteredPlanningArtifact> {
  const draft = await readAgentDraft(options.sourcePath);
  const result = validateArtifact("requirement-analysis", draft);
  if (!result.valid) {
    throw new QaSkillsError(`Requirement Analysis Agent Draft does not satisfy the artifact contract or authority rules: ${formatValidationErrors(result.errors)}`, "INVALID_ARTIFACT");
  }
  try {
    assertRequirementAuthorities(draft);
  } catch (error: unknown) {
    throw new QaSkillsError(error instanceof Error ? error.message : "Requirement authority verification failed", "INVALID_ARTIFACT");
  }
  const workspace = await RunWorkspace.open(options.root, options.runId);
  try {
    return await workspace.registerArtifactValue({
      type: "requirement-analysis",
      value: draft,
      relationships: options.relationships ?? [],
      provenance: "agent-draft",
    });
  } finally {
    await workspace.close();
  }
}
