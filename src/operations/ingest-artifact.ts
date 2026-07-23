import type { ArtifactType } from "../contracts/types.js";
import { QaSkillsError } from "../core/errors.js";
import { ingestRequirementAnalysis } from "./ingest-requirement-analysis.js";
import { ingestTestCases } from "./ingest-testcases.js";
import { ingestCoverageObligation } from "./ingest-coverage-obligation.js";

export async function ingestArtifact(options: { root: string; runId: string; type: ArtifactType; sourcePath: string; relationships?: string[] }): Promise<void> {
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
  throw new QaSkillsError(
    `${options.type} is runtime-owned and cannot cross the Agent Draft ingestion boundary`,
    "INVALID_ARTIFACT",
  );
}
