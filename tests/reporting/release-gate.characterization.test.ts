import { describe, expect, it } from "vitest";

import {
  deriveReleaseGateFromArtifacts,
  deriveReleaseGateFromWorkspaceArtifacts,
  evaluateReleaseGate,
  type GateWorkspaceArtifact,
  type ReleaseGateInput,
} from "../../src/reporting/release-gate.js";

// ---------------------------------------------------------------------------
// Task 7 (Phase 1) characterization of the release gate.
//
// This suite pins the CURRENT behavior of `evaluateReleaseGate`,
// `deriveReleaseGateFromWorkspaceArtifacts`, and `deriveReleaseGateFromArtifacts`
// exactly as they behave today, INCLUDING the known fail-OPEN bugs where a
// malformed artifact (or a severity-less triaged bug) silently vanishes instead
// of blocking release. Phase 2 refactors must keep these outputs identical;
// Phase 3/D9 will deliberately flip the fail-OPEN pins to fail-CLOSED. Each
// fail-open pin carries the required flip marker so Phase 3 can find it.
// ---------------------------------------------------------------------------

/** A baseline gate input where all six deterministic rules pass, yielding READY. */
const passing: ReleaseGateInput = {
  artifactsValid: true,
  coverage: { requiredMissing: [], optionalGaps: [], requiredHighRisk: [{ obligationId: "COV-PAY", passed: true }] },
  bugs: [],
  sharedBlockers: [],
};

/** Reads a single named rule verdict's pass/fail from an evaluated gate. */
function rulePassed(input: ReleaseGateInput, rule: string): boolean {
  const found = evaluateReleaseGate(input).verdicts.find((entry) => entry.rule === rule);
  if (!found) throw new Error(`Expected a verdict for rule ${rule}`);
  return found.passed;
}

/** A workspace artifact with the immutable record shape the gate consumes. */
function artifact(type: string, value: Record<string, unknown>, id: string, provenance?: string): GateWorkspaceArtifact {
  return {
    record: { id, sha256: "a".repeat(64), type, ...(provenance === undefined ? {} : { provenance }) },
    value,
  };
}

describe("evaluateReleaseGate — the six deterministic rules (one pass + one fail each)", () => {
  it("recommends READY when every rule passes", () => {
    const result = evaluateReleaseGate(passing);
    expect(result.recommendation).toBe("READY");
    expect(result.verdicts.every((entry) => entry.passed)).toBe(true);
  });

  const failingRules: readonly { rule: string; input: ReleaseGateInput }[] = [
    { rule: "VALID_ARTIFACTS", input: { ...passing, artifactsValid: false } },
    { rule: "NO_SHARED_BLOCKERS", input: { ...passing, sharedBlockers: ["database unavailable"] } },
    { rule: "NO_OPEN_BLOCKER_OR_CRITICAL", input: { ...passing, bugs: [{ bugId: "BUG-CRIT", triageStatus: "TRIAGED", severity: "Critical", open: true }] } },
    { rule: "NO_UNTRIAGED_PRODUCT_BUG", input: { ...passing, bugs: [{ bugId: "BUG-UNTRIAGED", triageStatus: "NEEDS_TRIAGE", open: true }] } },
    { rule: "REQUIRED_HIGH_RISK_PASSED", input: { ...passing, coverage: { ...passing.coverage, requiredHighRisk: [{ obligationId: "COV-PAY", passed: false }] } } },
    { rule: "REQUIRED_COVERAGE_COMPLETE", input: { ...passing, coverage: { ...passing.coverage, requiredMissing: ["COV-REQUIRED"] } } },
  ];

  it.each(failingRules)("blocks with NOT_READY when $rule fails", ({ rule, input }) => {
    // Passing fixture: the same rule is satisfied in the READY baseline above.
    expect(rulePassed(passing, rule)).toBe(true);
    // Failing fixture: a single hard-rule failure forces NOT_READY.
    expect(rulePassed(input, rule)).toBe(false);
    expect(evaluateReleaseGate(input).recommendation).toBe("NOT_READY");
  });
});

describe("evaluateReleaseGate — recommendation tiers", () => {
  it("recommends READY_WITH_RISKS for an optional coverage gap", () => {
    expect(evaluateReleaseGate({ ...passing, coverage: { ...passing.coverage, optionalGaps: ["COV-OPTIONAL"] } }).recommendation).toBe("READY_WITH_RISKS");
  });

  it("recommends READY_WITH_RISKS for an open non-critical (Major) triaged bug", () => {
    expect(evaluateReleaseGate({ ...passing, bugs: [{ bugId: "BUG-MAJOR", triageStatus: "TRIAGED", severity: "Major", open: true }] }).recommendation).toBe("READY_WITH_RISKS");
  });

  it("recommends READY when there is no failure and no risk", () => {
    expect(evaluateReleaseGate(passing)).toMatchObject({ recommendation: "READY", ruleInputs: passing });
  });
});

describe("deriveReleaseGateFromWorkspaceArtifacts — silent-drop paths (fail-OPEN)", () => {
  it("drops a malformed required-critical coverage obligation whose viewport height is missing", () => {
    // required: true + risk: critical, but viewport.height is absent, so the
    // obligation is dropped at release-gate.ts:84 (return []). It therefore
    // cannot appear in requiredMissing or requiredHighRisk.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("coverage-obligation", {
        obligationId: "COV-CRIT", requirementId: "REQ-1", role: "member", behavior: "pay",
        browser: "chromium", risk: "critical", outcome: "charged", required: true,
        viewport: { width: 1440 },
      }, "OBL-1"),
    ]);
    expect(result.ruleInputs.coverage.requiredMissing).toEqual([]);
    expect(result.ruleInputs.coverage.requiredHighRisk).toEqual([]);
    // CHARACTERIZATION: pins current fail-OPEN behavior; Phase 3/D9 will change this to NOT_READY.
    expect(result.recommendation).toBe("READY");
  });

  it("drops a malformed required-critical coverage obligation whose outcome field is missing", () => {
    // viewport is well-formed, but a required string field (outcome) is absent,
    // so the obligation is dropped at the field-parse guard (release-gate.ts:86).
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("coverage-obligation", {
        obligationId: "COV-CRIT2", requirementId: "REQ-1", role: "member", behavior: "pay",
        browser: "chromium", risk: "critical", required: true,
        viewport: { width: 1440, height: 900 },
      }, "OBL-2"),
    ]);
    expect(result.ruleInputs.coverage.requiredMissing).toEqual([]);
    expect(result.ruleInputs.coverage.requiredHighRisk).toEqual([]);
    // CHARACTERIZATION: pins current fail-OPEN behavior; Phase 3/D9 will change this to NOT_READY.
    expect(result.recommendation).toBe("READY");
  });

  it("drops a runtime test-result that fails the field-parse (missing status)", () => {
    // The attempt matches a registered test case (so it clears the dimensions
    // guard at release-gate.ts:93) but is missing a required string field
    // (status), so it is dropped at the field-parse guard (release-gate.ts:95).
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("test-case", {
        testCaseId: "TC-1", revisionId: "REV-1", instanceId: "INST-1",
        coverage: { requirementId: "REQ-1", role: "member", behavior: "pay", browser: "chromium", viewport: { width: 1440, height: 900 }, risk: "critical", outcome: "charged" },
      }, "TC-ART-1"),
      artifact("test-result", {
        attemptId: "ATT-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1",
      }, "RES-1", "runtime-execution"),
    ]);
    // CHARACTERIZATION: pins current fail-OPEN behavior; Phase 3/D9 will change this to NOT_READY.
    expect(result.recommendation).toBe("READY");
  });

  it("drops a runtime test-result whose test case cannot be found (missing dimensions)", () => {
    // No registered test case matches, so the attempt is dropped at the
    // dimensions guard (release-gate.ts:93).
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("test-result", {
        attemptId: "ATT-2", status: "PASSED", testCaseId: "TC-GHOST", testCaseRevisionId: "REV-GHOST", testCaseInstanceId: "INST-GHOST",
      }, "RES-2", "runtime-execution"),
    ]);
    // CHARACTERIZATION: pins current fail-OPEN behavior; Phase 3/D9 will change this to NOT_READY.
    expect(result.recommendation).toBe("READY");
  });

  it("drops an open Critical bug report whose open field is not a boolean", () => {
    // The bug is an open TRIAGED Critical blocker, but open is a string, so the
    // whole record is dropped from bugs at release-gate.ts:112.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("bug-report", { bugId: "BUG-1", triageStatus: "TRIAGED", severity: "Critical", open: "true" }, "BUG-ART-1"),
    ]);
    expect(result.ruleInputs.bugs).toEqual([]);
    // CHARACTERIZATION: pins current fail-OPEN behavior; Phase 3/D9 will change this to NOT_READY.
    expect(result.recommendation).toBe("READY");
  });

  it("drops an open Critical bug report whose triageStatus is not a known value", () => {
    // triageStatus is neither NEEDS_TRIAGE nor TRIAGED, so the record is dropped
    // from bugs at release-gate.ts:112.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("bug-report", { bugId: "BUG-2", triageStatus: "CLOSED", severity: "Critical", open: true }, "BUG-ART-2"),
    ]);
    expect(result.ruleInputs.bugs).toEqual([]);
    // CHARACTERIZATION: pins current fail-OPEN behavior; Phase 3/D9 will change this to NOT_READY.
    expect(result.recommendation).toBe("READY");
  });

  it("skips a bug report that has no bugId", () => {
    // Without a bugId the record is skipped before the latest-revision map at
    // release-gate.ts:104, so an open Critical blocker never reaches bugs.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("bug-report", { triageStatus: "TRIAGED", severity: "Critical", open: true }, "BUG-ART-3"),
    ]);
    expect(result.ruleInputs.bugs).toEqual([]);
    // CHARACTERIZATION: pins current fail-OPEN behavior; Phase 3/D9 will change this to NOT_READY.
    expect(result.recommendation).toBe("READY");
  });
});

describe("deriveReleaseGateFromWorkspaceArtifacts — severity-optional path (fail-OPEN)", () => {
  it("treats an open TRIAGED bug with no severity as a mere risk, not a blocker", () => {
    // severity is absent, so it is omitted at release-gate.ts:113-114 and the
    // bug becomes a non-critical risk rather than an open blocker.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("bug-report", { bugId: "BUG-SEV", triageStatus: "TRIAGED", open: true }, "BUG-ART-4"),
    ]);
    expect(result.ruleInputs.bugs).toEqual([{ bugId: "BUG-SEV", triageStatus: "TRIAGED", open: true }]);
    // CHARACTERIZATION: pins current fail-OPEN behavior; Phase 3/D9 will change this to NOT_READY.
    expect(result.recommendation).toBe("READY_WITH_RISKS");
  });

  it("treats an open TRIAGED bug with an unrecognized severity value as a mere risk", () => {
    // An out-of-enum severity ("Catastrophic") is stripped at release-gate.ts:113-114,
    // so again the bug is a non-critical risk rather than a blocker.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("bug-report", { bugId: "BUG-SEV2", triageStatus: "TRIAGED", severity: "Catastrophic", open: true }, "BUG-ART-5"),
    ]);
    expect(result.ruleInputs.bugs).toEqual([{ bugId: "BUG-SEV2", triageStatus: "TRIAGED", open: true }]);
    // CHARACTERIZATION: pins current fail-OPEN behavior; Phase 3/D9 will change this to NOT_READY.
    expect(result.recommendation).toBe("READY_WITH_RISKS");
  });
});

describe("deriveReleaseGateFromWorkspaceArtifacts — protected-environment label (Task 22 / D12 additive field)", () => {
  // CHARACTERIZATION UPDATE (Task 22): the workspace-derived gate now carries an additive,
  // INFORMATIONAL `protectedEnvironment` label derived purely from the persisted environment-profile
  // (classification production || evidenceProtection.protected || declared domSelectors/regions). It
  // is NOT part of ruleInputs and never feeds evaluateReleaseGate, so every recommendation pinned in
  // the suites above is UNCHANGED. Re-pinned here so the additive field is documented; the Phase-2
  // semantic rule compares it on both the derived and persisted sides, so the round-trip stays green.
  it("labels a run with no environment-profile as not protected, recommendation unchanged (READY)", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([]);
    expect(result.protectedEnvironment).toBe(false);
    expect(result.recommendation).toBe("READY");
  });

  it("labels a production-classified profile protected, recommendation unchanged (READY)", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([artifact("environment-profile", { classification: "production" }, "ENV-1")]);
    expect(result.protectedEnvironment).toBe(true);
    expect(result.recommendation).toBe("READY");
  });

  it("labels a profile declaring a redaction target protected even with protected unset and non-production classification", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([artifact("environment-profile", { classification: "test", evidenceProtection: { domSelectors: ["input#ssn"] } }, "ENV-2")]);
    expect(result.protectedEnvironment).toBe(true);
    expect(result.recommendation).toBe("READY");
  });
});

describe("deriveReleaseGateFromArtifacts — ignored incident/evidence-gap/cleanup inputs (fail-OPEN)", () => {
  it("accepts but never reads incidents, evidenceGaps, or cleanupLeaks", () => {
    const result = deriveReleaseGateFromArtifacts({
      artifactRecords: [{ id: "ART-1", sha256: "a".repeat(64), type: "test-case" }],
      coverage: passing.coverage,
      bugs: [],
      incidents: [{ incidentId: "INC-1", kind: "ENVIRONMENT_INCIDENT" }],
      evidenceGaps: [{ evidenceGapId: "GAP-1", affectedClaim: "video capture" }],
      cleanupLeaks: [{ id: "LEAK-1", status: "failed" }],
      sharedBlockers: [],
      artifactsValid: true,
    });
    // None of the three non-empty inputs reach evaluateReleaseGate; sharedBlockers
    // stays empty and the source artifacts are bound verbatim.
    expect(result.ruleInputs.sharedBlockers).toEqual([]);
    expect(result.sourceArtifacts).toEqual([{ id: "ART-1", sha256: "a".repeat(64), type: "test-case" }]);
    // CHARACTERIZATION: pins current fail-OPEN behavior; Phase 3/D9 will change this to NOT_READY.
    // The workspace variant (below) folds these same facts into sharedBlockers and blocks;
    // this sibling drops them, so an environment incident / evidence gap / cleanup leak passes.
    expect(result.recommendation).toBe("READY");
  });

  it("contrast: the workspace variant folds an equivalent evidence gap into a shared blocker (NOT_READY)", () => {
    // Demonstrates the divergence the CHARACTERIZATION comment above describes:
    // the same evidence-gap fact is a hard shared blocker in the workspace path.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("evidence-gap", { evidenceGapId: "GAP-1", affectedClaim: "video capture" }, "GAP-ART-1"),
    ]);
    expect(result.ruleInputs.sharedBlockers.length).toBeGreaterThan(0);
    expect(result.recommendation).toBe("NOT_READY");
  });
});
