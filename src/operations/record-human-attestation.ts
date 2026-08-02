import { createEntityId } from "../core/ids.js";
import { QaSkillsError } from "../core/errors.js";
import { RunWorkspace, type ArtifactRecord } from "../core/run-workspace.js";
import { runtimeVersion } from "../installer/manifest.js";
import { isManualAccessibilityMethod, manualAccessibilityMethods } from "../planning/coverage.js";

/**
 * Records a **Human Attestation** — "an identified person's immutable signed claim that an evaluation
 * no machine performed was actually carried out" (CONTEXT.md:143-145).
 *
 * This is the one artifact in Phase 6 that ships with a producer, and the asymmetry is deliberate. An
 * AUTOMATED Accessibility Obligation is blocked on an accessibility scanner that does not exist in
 * this repo, so leaving it unsatisfiable is honest. A MANUAL one is blocked on nothing but a command:
 * a person can carry out a keyboard or screen-reader evaluation today, so shipping the shape without
 * a way to record it would make every manual accessibility obligation permanently unmet.
 *
 * `record-human-approval.ts` is the shape this follows (operation + CLI entry point + a provenance
 * value no agent-draft path can write). The two concepts stay separate: an approval-decision
 * authorises a plan; this records that an evaluation happened. The glossary's own `_Avoid_` line for
 * Human Attestation names "sign-off, approval decision" as exactly what it must not be confused with.
 */
export async function recordHumanAttestation(input: {
  root: string;
  runId: string;
  obligationId: string;
  method: string;
  attestedBy: string;
  statement: string;
}): Promise<ArtifactRecord> {
  const attestedBy = input.attestedBy.trim();
  const statement = input.statement.trim();
  if (attestedBy === "") throw new QaSkillsError("Human attester identity is required", "INVALID_ARTIFACT");
  // Checked here as well as in the schema so the category error gets a message that explains itself:
  // CONTEXT.md:438 lets a Human Attestation satisfy only a MANUAL obligation, so a person claiming
  // `automated-analysis` is asserting they personally performed a machine analysis.
  if (!isManualAccessibilityMethod(input.method)) {
    throw new QaSkillsError(
      `A Human Attestation records a manual evaluation only: ${manualAccessibilityMethods.join(", ")}`,
      "INVALID_ARTIFACT",
    );
  }
  const workspace = await RunWorkspace.open(input.root, input.runId);
  try {
    const artifacts = await workspace.readRegisteredArtifacts();
    const matches = artifacts.filter((artifact) => artifact.record.type === "coverage-obligation" && artifact.value.obligationId === input.obligationId);
    const obligation = matches.length === 1 ? matches[0] : undefined;
    if (!obligation) {
      throw new QaSkillsError("Human attestation requires exactly one registered coverage obligation carrying that obligation ID", "ARTIFACT_BINDING");
    }
    if (obligation.value.accessibilityMethod !== input.method) {
      throw new QaSkillsError("Human attestation method must equal the accessibility method its obligation declares", "ARTIFACT_BINDING");
    }
    // `statement`'s floor lives only in the schema, so there is exactly one place it can drift from;
    // registration below rejects a substanceless statement with the schema's own diagnostic.
    // `return await` (not a bare `return`) so a synchronous contract rejection is observed inside this
    // `try` rather than after the `finally` has already detached — otherwise it surfaces as an
    // unhandled rejection warning even though the caller does catch it.
    return await workspace.registerArtifactValue({
      type: "human-attestation",
      relationships: [obligation.record.id],
      provenance: `human-attestation:${attestedBy}`,
      value: {
        artifactType: "human-attestation",
        schemaVersion: "2.0.0",
        producerVersion: runtimeVersion,
        attestationId: createEntityId(),
        runId: workspace.runId,
        obligationId: input.obligationId,
        obligationSha256: obligation.record.sha256,
        method: input.method,
        attestedBy,
        attestedAt: new Date().toISOString(),
        statement,
      },
    });
  } finally {
    await workspace.close();
  }
}
