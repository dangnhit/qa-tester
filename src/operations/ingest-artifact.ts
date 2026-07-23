import { parseAuthoringDocument } from "../contracts/authoring.js";
import type { ArtifactType } from "../contracts/types.js";
import { validateArtifact } from "../contracts/validator.js";
import { QaSkillsError } from "../core/errors.js";
import { RunWorkspace } from "../core/run-workspace.js";
import { ingestRequirementAnalysis } from "./ingest-requirement-analysis.js";
import { ingestTestCases } from "./ingest-testcases.js";
import { ingestCoverageObligation } from "./ingest-coverage-obligation.js";

export async function ingestArtifact(options: { root: string; runId: string; type: ArtifactType; sourcePath: string; relationships?: string[] }): Promise<void> {
  if (options.type === "bug-report" || options.type === "incident" || options.type === "release-gate" || options.type === "qa-execution-report") {
    throw new QaSkillsError("Defects, incidents, gates, and reports must be generated from registered runtime artifacts", "INVALID_ARTIFACT");
  }
  if (options.type === "requirement-analysis") {
    await ingestRequirementAnalysis(options);
    return;
  }
  if (options.type === "test-plan") {
    await ingestTestCases(options);
    return;
  }
  if (options.type === "coverage-obligation") {
    await ingestCoverageObligation(options);
    return;
  }
  const source = await readFile(options.sourcePath, "utf8");
  const format = options.sourcePath.endsWith(".yaml") || options.sourcePath.endsWith(".yml") ? "yaml" : "json";
  const draft = parseAuthoringDocument(source, format);
  if (!validateArtifact(options.type, draft).valid) throw new QaSkillsError("Agent Draft does not satisfy the artifact contract", "INVALID_ARTIFACT");
  const workspace = await RunWorkspace.open(options.root, options.runId);
  try {
    await workspace.registerArtifact({ type: options.type, sourcePath: options.sourcePath, relationships: options.relationships ?? [], provenance: "agent-draft" });
  } finally {
    await workspace.close();
  }
}
import { readFile } from "node:fs/promises";
