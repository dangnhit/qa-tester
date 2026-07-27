import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { agentDraftTypes } from "../../src/cli/artifact-drafts.js";
import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";
import { artifactTypes } from "../../src/contracts/types.js";
import { validateArtifact } from "../../src/contracts/validator.js";
import { sha256Text } from "../../src/core/checksum.js";
import { QaSkillsError } from "../../src/core/errors.js";
import type { ArtifactRecord, WorkspaceDiagnostic } from "../../src/core/run-workspace.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { ingestArtifact } from "../../src/operations/ingest-artifact.js";
import { recordHumanAttestation } from "../../src/operations/record-human-attestation.js";

/**
 * `human-attestation` (Task 34) — the artifact CONTEXT.md:143-145 calls "an identified person's
 * immutable signed claim that an evaluation no machine performed was actually carried out", and the
 * only thing CONTEXT.md:438 says can satisfy a MANUAL Accessibility Obligation.
 *
 * Task 34 builds the shape and its producer; Task 35 changes what satisfies an obligation. Nothing
 * here asserts anything about coverage crediting — `matchesObligation` still compares labels.
 */

const roots: string[] = [];
const openWorkspaces: RunWorkspace[] = [];

afterEach(async () => {
  await Promise.all(openWorkspaces.splice(0).map((workspace) => workspace.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const environmentProfile = {
  artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0",
  environmentProfileId: "env-test", name: "Test", classification: "test",
  baseUrl: "https://test.example.test", productionReadOnly: false,
} as const;

const statement = "Navigated the whole checkout flow with the keyboard only; every control was reachable and focus stayed visible.";

type Fixture = {
  root: string;
  workspace: RunWorkspace;
  obligation: ArtifactRecord;
};

/** The same fixture with its workspace handle released, so the producer (which opens the run itself,
 *  exactly as the CLI does) is not blocked by this test's own live lock. */
async function closedFixture(obligationMethod: string | null = "keyboard"): Promise<Fixture> {
  const built = await fixture(obligationMethod);
  await built.workspace.close();
  return built;
}

/** A run holding one authoritative requirement and one MANUAL-surface accessibility obligation. */
async function fixture(obligationMethod: string | null = "keyboard"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "qa-skills-human-attestation-"));
  roots.push(root);
  const workspace = await RunWorkspace.create({ root, mode: "plan", environmentProfile });
  openWorkspaces.push(workspace);
  const analysis = await workspace.registerArtifactValue({
    type: "requirement-analysis", relationships: [],
    value: {
      artifactType: "requirement-analysis", schemaVersion: "1.0.0", producerVersion: "1.0.0", requirementAnalysisId: "RA",
      statements: [{
        requirementId: "REQ", sourceProvenance: { kind: "user", reference: "ticket-1" },
        normalizedText: "Members must be able to complete checkout with the keyboard alone.",
        authority: "AUTHORITATIVE", role: "member", rules: [], risks: [], assumptions: [], openQuestions: [],
      }],
    },
  });
  const obligation = await workspace.registerArtifactValue({
    type: "coverage-obligation", relationships: [],
    value: {
      artifactType: "coverage-obligation", schemaVersion: "3.0.0", producerVersion: "1.0.0", obligationId: "COV-A11Y",
      requirementAnalysisArtifactId: analysis.id, requirementId: "REQ", role: "member", behavior: "complete checkout",
      executionSurface: "manual", accessibilityMethod: obligationMethod, risk: "high", required: true,
      outcome: "Order confirmation is shown",
    },
  });
  return { root, workspace, obligation };
}

/** A schema-valid attestation for `fixture()`'s obligation, before any override. */
function attestation(obligation: ArtifactRecord, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactType: "human-attestation", schemaVersion: "1.0.0", producerVersion: "1.0.0",
    attestationId: "ATTESTATION-1", runId: "REPLACED-BY-CALLER", obligationId: "COV-A11Y",
    obligationSha256: obligation.sha256, method: "keyboard",
    attestedBy: "reviewer@example.test", attestedAt: "2026-07-25T09:00:00.000Z", statement,
    ...overrides,
  };
}

async function expectQaReject(promise: Promise<unknown>, code: string, message: string | RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(QaSkillsError);
  const error = caught as QaSkillsError;
  expect(error.code).toBe(code);
  if (typeof message === "string") expect(error.message).toBe(message);
  else expect(error.message).toMatch(message);
}

async function targetDiagnostics(workspace: RunWorkspace, relativePath: string): Promise<WorkspaceDiagnostic[]> {
  const { diagnostics } = await workspace.validate();
  return diagnostics.filter((diagnostic) => diagnostic.relativePath === relativePath);
}

/** Rewrites a registered artifact's bytes and recomputes its manifest checksum, so the tampered
 *  payload survives the integrity gate and reaches the READ-path semantic rules. */
async function tamperRegistered(workspacePath: string, type: string, mutate: (value: Record<string, unknown>) => void): Promise<void> {
  const manifestPath = join(workspacePath, "artifact-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { type: string; relativePath: string; sha256: string }[] };
  const record = manifest.artifacts.find((artifact) => artifact.type === type);
  if (!record) throw new Error(`Missing registered ${type}`);
  const filePath = join(workspacePath, record.relativePath);
  const value = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  mutate(value);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, contents);
  record.sha256 = sha256Text(contents);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("recordHumanAttestation (the producer)", () => {
  it("records an attestation that validates, registers, and carries a human provenance", async () => {
    const { root, workspace, obligation } = await closedFixture();

    const record = await recordHumanAttestation({
      root, runId: workspace.runId, obligationId: "COV-A11Y", method: "keyboard",
      attestedBy: "reviewer@example.test", statement,
    });

    expect(record.type).toBe("human-attestation");
    expect(record.provenance).toBe("human-attestation:reviewer@example.test");
    expect(record.relationships).toEqual([obligation.id]);
    const value = JSON.parse(await readFile(join(workspace.path, record.relativePath), "utf8")) as Record<string, unknown>;
    expect(validateArtifact("human-attestation", value).valid).toBe(true);
    expect(value).toMatchObject({
      artifactType: "human-attestation", schemaVersion: "1.0.0", runId: workspace.runId,
      obligationId: "COV-A11Y", method: "keyboard", attestedBy: "reviewer@example.test", statement,
    });
    // The claim is auditable against immutable bytes, not against whatever the manifest resolves later.
    expect(value.obligationSha256).toBe(obligation.sha256);
    // Reopened from disk: the attestation binds cleanly on the READ path too, so it survives every
    // subsequent workspace read rather than only the write that created it.
    const reopened = await RunWorkspace.open(root, workspace.runId);
    openWorkspaces.push(reopened);
    const registered = await reopened.readRegisteredArtifacts();
    expect(registered.some((artifact) => artifact.record.id === record.id)).toBe(true);
  });

  it("refuses to record a human claim of automated analysis", async () => {
    const { root, workspace } = await closedFixture("automated-analysis");

    await expectQaReject(
      recordHumanAttestation({ root, runId: workspace.runId, obligationId: "COV-A11Y", method: "automated-analysis", attestedBy: "reviewer", statement }),
      "INVALID_ARTIFACT",
      /manual/i,
    );
  });

  it("refuses an evaluation method that is not one of the four declared categories", async () => {
    const { root, workspace } = await closedFixture();

    await expectQaReject(
      recordHumanAttestation({ root, runId: workspace.runId, obligationId: "COV-A11Y", method: "manual-keyboard", attestedBy: "reviewer", statement }),
      "INVALID_ARTIFACT",
      /manual/i,
    );
  });

  it("refuses an unidentified attester", async () => {
    const { root, workspace } = await closedFixture();

    await expectQaReject(
      recordHumanAttestation({ root, runId: workspace.runId, obligationId: "COV-A11Y", method: "keyboard", attestedBy: "   ", statement }),
      "INVALID_ARTIFACT",
      /identity/i,
    );
  });

  it("refuses a statement carrying no substance", async () => {
    const { root, workspace } = await closedFixture();

    await expect(recordHumanAttestation({
      root, runId: workspace.runId, obligationId: "COV-A11Y", method: "keyboard", attestedBy: "reviewer", statement: "  done  ",
    })).rejects.toThrow(/statement/i);
  });

  it("refuses to attest to an obligation no registered artifact carries", async () => {
    const { root, workspace } = await closedFixture();

    await expectQaReject(
      recordHumanAttestation({ root, runId: workspace.runId, obligationId: "COV-MISSING", method: "keyboard", attestedBy: "reviewer", statement }),
      "ARTIFACT_BINDING",
      /obligation/i,
    );
  });

  it.each([
    ["a different declared method", "screen-reader"],
    ["no declared method at all", null],
  ] as const)("refuses to attest to an obligation declaring %s", async (_label, obligationMethod) => {
    const { root, workspace } = await closedFixture(obligationMethod);

    await expectQaReject(
      recordHumanAttestation({ root, runId: workspace.runId, obligationId: "COV-A11Y", method: "keyboard", attestedBy: "reviewer", statement }),
      "ARTIFACT_BINDING",
      /method/i,
    );
  });
});

describe("human-attestation semantic rule", () => {
  it("WRITE accepts an attestation bound to the one obligation declaring its method", async () => {
    const { workspace, obligation } = await fixture();

    await expect(workspace.registerArtifactValue({
      type: "human-attestation", relationships: [obligation.id], provenance: "human-attestation:reviewer",
      value: attestation(obligation, { runId: workspace.runId }),
    })).resolves.toMatchObject({ type: "human-attestation" });
  });

  it("WRITE rejects an attestation bound to no obligation at all", async () => {
    const { workspace, obligation } = await fixture();

    await expectQaReject(
      workspace.registerArtifactValue({
        type: "human-attestation", relationships: [], provenance: "human-attestation:reviewer",
        value: attestation(obligation, { runId: workspace.runId }),
      }),
      "ARTIFACT_BINDING",
      "Human attestation must bind one exact immutable coverage obligation",
    );
  });

  it("WRITE rejects an attestation naming an obligation ID nothing registered carries", async () => {
    const { workspace, obligation } = await fixture();

    await expectQaReject(
      workspace.registerArtifactValue({
        type: "human-attestation", relationships: [obligation.id], provenance: "human-attestation:reviewer",
        value: attestation(obligation, { runId: workspace.runId, obligationId: "COV-OTHER" }),
      }),
      "ARTIFACT_BINDING",
      "Human attestation must bind one exact immutable coverage obligation",
    );
  });

  it("WRITE rejects an attestation whose obligation checksum does not match the bound obligation", async () => {
    const { workspace, obligation } = await fixture();

    await expectQaReject(
      workspace.registerArtifactValue({
        type: "human-attestation", relationships: [obligation.id], provenance: "human-attestation:reviewer",
        value: attestation(obligation, { runId: workspace.runId, obligationSha256: "c".repeat(64) }),
      }),
      "ARTIFACT_BINDING",
      "Human attestation must bind one exact immutable coverage obligation",
    );
  });

  it.each([
    ["a different method", "screen-reader"],
    ["no method at all", null],
  ] as const)("WRITE rejects an attestation for an obligation declaring %s", async (_label, obligationMethod) => {
    const { workspace, obligation } = await fixture(obligationMethod);

    await expectQaReject(
      workspace.registerArtifactValue({
        type: "human-attestation", relationships: [obligation.id], provenance: "human-attestation:reviewer",
        value: attestation(obligation, { runId: workspace.runId }),
      }),
      "ARTIFACT_BINDING",
      "Human attestation method must equal the accessibility method its obligation declares",
    );
  });

  it("READ invalidates a persisted attestation whose method was rewritten away from its obligation's", async () => {
    const { workspace, obligation } = await fixture();
    const record = await workspace.registerArtifactValue({
      type: "human-attestation", relationships: [obligation.id], provenance: "human-attestation:reviewer",
      value: attestation(obligation, { runId: workspace.runId }),
    });

    await tamperRegistered(workspace.path, "human-attestation", (value) => { value.method = "screen-reader"; });

    expect(await targetDiagnostics(workspace, record.relativePath)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "INVALID_REFERENCE",
        message: "Human attestation method must equal the accessibility method its obligation declares",
      }),
    ]));
  });

  it("READ invalidates a persisted attestation whose obligation was rewritten underneath it", async () => {
    const { workspace, obligation } = await fixture();
    const record = await workspace.registerArtifactValue({
      type: "human-attestation", relationships: [obligation.id], provenance: "human-attestation:reviewer",
      value: attestation(obligation, { runId: workspace.runId }),
    });

    // Rewriting the obligation changes its checksum, so the attestation no longer names the exact
    // immutable bytes its author saw — the whole point of carrying `obligationSha256`.
    await tamperRegistered(workspace.path, "coverage-obligation", (value) => { value.behavior = "complete checkout twice"; });

    expect(await targetDiagnostics(workspace, record.relativePath)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "INVALID_REFERENCE",
        message: "Human attestation must bind one exact immutable coverage obligation",
      }),
    ]));
  });
});

describe("the agent-draft ingestion boundary", () => {
  it("knows human-attestation as an artifact type, so the refusal below is the boundary's and not an unknown-type error", () => {
    expect([...artifactTypes]).toContain("human-attestation");
  });

  it("refuses a human-attestation across the ingestion boundary — an agent must not forge a signed human claim", async () => {
    const { root, workspace, obligation } = await closedFixture();
    const filePath = join(root, "forged-attestation.json");
    await writeFile(filePath, JSON.stringify(attestation(obligation, { runId: workspace.runId }), null, 2));

    await expectQaReject(
      ingestArtifact({ root, runId: workspace.runId, type: "human-attestation", sourcePath: filePath, relationships: [obligation.id] }),
      "INVALID_ARTIFACT",
      "human-attestation is runtime-owned and cannot cross the Agent Draft ingestion boundary",
    );

    const cli = await runCli(
      ["artifact", "ingest", "--root", root, "--run-id", workspace.runId, "--type", "human-attestation", "--file", filePath],
      { cwd: root },
    );
    expect(cli.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(cli.stderr).toBe("human-attestation is runtime-owned and cannot cross the Agent Draft ingestion boundary\n");

    // Nothing reached the manifest: the refusal is a refusal, not a rollback after a partial write.
    const reopened = await RunWorkspace.open(root, workspace.runId);
    openWorkspaces.push(reopened);
    const registered = await reopened.readRegisteredArtifacts();
    expect(registered.some((artifact) => artifact.record.type === "human-attestation")).toBe(false);
  });

  it("gives an agent no draft skeleton to start from", async () => {
    expect([...agentDraftTypes]).not.toContain("human-attestation");

    const cli = await runCli(["draft", "init", "--type", "human-attestation"], { cwd: process.cwd() });

    expect(cli.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(cli.stdout).toBe("");
    expect(cli.stderr).toContain("runtime-owned");
  });
});

describe("qa-skill attestation record (the CLI producer)", () => {
  it("records an attestation and prints its manifest record", async () => {
    const { root, workspace, obligation } = await closedFixture();

    const cli = await runCli([
      "attestation", "record", "--root", root, "--run-id", workspace.runId,
      "--obligation-id", "COV-A11Y", "--method", "keyboard",
      "--attested-by", "reviewer@example.test", "--statement", statement,
    ], { cwd: root });

    expect(cli.stderr).toBe("");
    expect(cli.exitCode).toBe(ExitCode.SUCCESS);
    const printed = JSON.parse(cli.stdout) as ArtifactRecord;
    expect(printed).toMatchObject({
      type: "human-attestation",
      provenance: "human-attestation:reviewer@example.test",
      relationships: [obligation.id],
    });
  });
});
