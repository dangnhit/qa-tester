import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RunWorkspace } from "../../src/core/run-workspace.js";
import { generateQaReport } from "../../src/operations/generate-qa-report.js";
import { renderCanonicalJson } from "../../src/reporting/render-json.js";
import { renderMarkdown } from "../../src/reporting/render-markdown.js";
import {
  deriveReleaseGateFromWorkspaceArtifacts,
  type GateWorkspaceArtifact,
} from "../../src/reporting/release-gate.js";
import type { QaReportModel } from "../../src/reporting/report-model.js";

// ---------------------------------------------------------------------------
// Task 22 (Phase 3 / D12) — deterministic protected-environment LABEL on the
// release gate + honest surfacing in the QA report.
//
// The label is derived PURELY from the persisted environment-profile
// (classification production || evidenceProtection.protected || declared
// domSelectors/regions). It is INFORMATIONAL and MUST NOT change the gate
// recommendation. These tests pin the derivation, the recommendation-unchanged
// invariant, the semantic-rule round-trip (no INVALID_REFERENCE), and the
// report surfacing.
// ---------------------------------------------------------------------------

/** A workspace artifact with the immutable record shape the gate consumes. */
function artifact(type: string, value: Record<string, unknown>, id: string, provenance?: string): GateWorkspaceArtifact {
  return {
    record: { id, sha256: "a".repeat(64), type, ...(provenance === undefined ? {} : { provenance }) },
    value,
  };
}

/** A minimal environment-profile artifact carrying only the fields the label reads. */
function profile(evidenceProtection: Record<string, unknown> | undefined, classification = "test"): GateWorkspaceArtifact {
  return artifact("environment-profile", {
    artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0",
    environmentProfileId: "ENV-1", name: "fixture", classification, baseUrl: "https://example.test",
    productionReadOnly: classification === "production",
    ...(evidenceProtection === undefined ? {} : { evidenceProtection }),
  }, "ENV-ART-1");
}

describe("release-gate protected-environment label — derivation", () => {
  it("labels a production-classified profile as protected", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([profile(undefined, "production")]);
    expect(result.protectedEnvironment).toBe(true);
  });

  it("labels a profile that explicitly opts into protected as protected", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([profile({ protected: true })]);
    expect(result.protectedEnvironment).toBe(true);
  });

  it("labels a profile declaring a dom-selector redaction target as protected (protected unset, non-production)", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([profile({ domSelectors: ["input#ssn"] })]);
    expect(result.protectedEnvironment).toBe(true);
  });

  it("labels a profile declaring a region redaction target as protected", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([profile({ regions: [{ x: 0, y: 0, width: 10, height: 10 }] })]);
    expect(result.protectedEnvironment).toBe(true);
  });

  it("does not label a plain local/test profile with no redaction targets as protected", () => {
    expect(deriveReleaseGateFromWorkspaceArtifacts([profile(undefined)]).protectedEnvironment).toBe(false);
    expect(deriveReleaseGateFromWorkspaceArtifacts([profile({ retainTrace: true })]).protectedEnvironment).toBe(false);
  });

  it("defaults to not-protected when no environment-profile is registered", () => {
    expect(deriveReleaseGateFromWorkspaceArtifacts([]).protectedEnvironment).toBe(false);
  });
});

describe("release-gate protected-environment label — informational (recommendation unchanged)", () => {
  const evidenceGap = artifact("evidence-gap", {
    evidenceGapId: "GAP-1", affectedClaim: "video capture", reason: "Required video could not be captured.",
  }, "GAP-ART-1");

  it("keeps a READY recommendation READY regardless of the label", () => {
    const unprotected = deriveReleaseGateFromWorkspaceArtifacts([profile(undefined)]);
    const protectedRun = deriveReleaseGateFromWorkspaceArtifacts([profile({ protected: true })]);
    expect(unprotected.recommendation).toBe("READY");
    expect(protectedRun.recommendation).toBe("READY");
    // Only the label differs; the verdict is identical.
    expect(protectedRun.protectedEnvironment).toBe(true);
    expect(unprotected.protectedEnvironment).toBe(false);
    expect(protectedRun.verdicts).toEqual(unprotected.verdicts);
  });

  it("keeps a NOT_READY recommendation NOT_READY regardless of the label", () => {
    const unprotected = deriveReleaseGateFromWorkspaceArtifacts([profile(undefined), evidenceGap]);
    const protectedRun = deriveReleaseGateFromWorkspaceArtifacts([profile({ protected: true }), evidenceGap]);
    expect(unprotected.recommendation).toBe("NOT_READY");
    expect(protectedRun.recommendation).toBe("NOT_READY");
    expect(protectedRun.protectedEnvironment).toBe(true);
    expect(unprotected.protectedEnvironment).toBe(false);
    expect(protectedRun.verdicts).toEqual(unprotected.verdicts);
  });
});

describe("release-gate protected-environment label — determinism / semantic round-trip", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  const protectedProfile = {
    artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0",
    environmentProfileId: "ENV-PROTECTED", name: "protected", classification: "test",
    baseUrl: "https://example.test", productionReadOnly: false,
    evidenceProtection: { domSelectors: ["input#ssn"] },
  } as const;

  it("round-trips a persisted gate + report carrying the label without an INVALID_REFERENCE", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-protected-label-")); roots.push(root);
    const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: protectedProfile });
    const generated = await generateQaReport({ workspace });

    // The persisted gate + embedded report gate carry the label from the profile.
    const registered = await workspace.readRegisteredArtifacts();
    const gate = registered.find((entry) => entry.record.type === "release-gate");
    expect(gate?.value.protectedEnvironment).toBe(true);
    expect((JSON.parse(generated.json) as { protectedEnvironment: boolean }).protectedEnvironment).toBe(true);
    await workspace.close();

    // Re-opening re-derives the gate and compares it to the persisted snapshot. Because the label is
    // on BOTH the derived and persisted sides, the binding check passes: no INVALID_REFERENCE anywhere,
    // and no binding diagnostic is attributed to the persisted gate or the embedded-gate report.
    // (Overall `valid` is false only because this minimal workspace lacks the execute-profile's other
    // required artifacts — unrelated to the gate label.)
    const reopened = await RunWorkspace.open(root, workspace.runId);
    const { diagnostics } = await reopened.validate();
    await reopened.close();
    expect(diagnostics.filter((diagnostic) => diagnostic.code === "INVALID_REFERENCE")).toEqual([]);
    expect(diagnostics.filter((diagnostic) =>
      diagnostic.relativePath === generated.gate.relativePath || diagnostic.relativePath === generated.report.relativePath)).toEqual([]);
  });
});

describe("release-gate protected-environment label — report rendering", () => {
  const base: QaReportModel = {
    artifactType: "qa-execution-report", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: "run-report",
    generatedAt: "2026-07-23T12:00:00.000Z", build: { identifier: "build-42" }, summary: "None.",
    coverageMethods: [], incidents: [], bugs: [], telemetryFindings: [], evidenceGaps: [], cleanupLeaks: [],
    criticalFindings: [], remainingRisks: [], excludedNotRun: [], protectedEnvironment: false,
    releaseGate: { recommendation: "READY", ruleInputs: { artifactsValid: true, coverage: { requiredMissing: [], optionalGaps: [], requiredHighRisk: [] }, bugs: [], sharedBlockers: [] }, verdicts: [] },
  };

  it("surfaces the label true in the canonical JSON and a protected line in the Markdown", () => {
    const model = { ...base, protectedEnvironment: true };
    expect((JSON.parse(renderCanonicalJson(model)) as { protectedEnvironment: boolean }).protectedEnvironment).toBe(true);
    const english = renderMarkdown(model, "en");
    expect(english).toContain("Protected environment — evidence was redacted before persistence");
    // Canonical value is not translated across locales.
    expect(renderMarkdown(model, "vi")).toContain("Protected environment — evidence was redacted before persistence");
  });

  it("negates the label in the canonical JSON and Markdown when the run was not protected", () => {
    expect((JSON.parse(renderCanonicalJson(base)) as { protectedEnvironment: boolean }).protectedEnvironment).toBe(false);
    const english = renderMarkdown(base, "en");
    expect(english).not.toContain("evidence was redacted before persistence");
    expect(english).toContain("Not a protected environment");
  });
});
