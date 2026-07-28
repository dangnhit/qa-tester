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
        executionSurface: "browser", browser: "chromium", risk: "critical", outcome: "charged", required: true,
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
        executionSurface: "browser", browser: "chromium", risk: "critical", required: true,
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
        attemptId: "ATT-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1", observedEngine: "chromium",
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
        attemptId: "ATT-2", status: "PASSED", testCaseId: "TC-GHOST", testCaseRevisionId: "REV-GHOST", testCaseInstanceId: "INST-GHOST", observedEngine: "chromium",
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

describe("deriveReleaseGateFromWorkspaceArtifacts — coverage credit by provenance (Task 27)", () => {
  // Shared dimensions for an authoritative, required, high-risk coverage
  // obligation and the test case / test result that can (or cannot) satisfy it.
  const dimensions = {
    requirementId: "REQ-CREDIT", role: "member", behavior: "save profile", browser: "chromium",
    viewport: { width: 1440, height: 900 }, risk: "high", outcome: "confirmation shown",
  };

  /** Builds a minimal workspace with one obligation and one matching test-result at the given provenance. */
  function fixtureArtifacts(resultProvenance?: string): GateWorkspaceArtifact[] {
    return [
      artifact("requirement-analysis", {
        statements: [{ requirementId: dimensions.requirementId, authority: "AUTHORITATIVE" }],
      }, "RA-CREDIT"),
      artifact("coverage-obligation", {
        obligationId: "COV-CREDIT", requirementAnalysisArtifactId: "RA-CREDIT", required: true, executionSurface: "browser", ...dimensions,
      }, "OBL-CREDIT"),
      artifact("test-case", {
        testCaseId: "TC-CREDIT", revisionId: "REV-CREDIT", instanceId: "INST-CREDIT", coverage: dimensions,
      }, "TC-ART-CREDIT"),
      artifact("test-result", {
        attemptId: "ATT-CREDIT", status: "PASSED", testCaseId: "TC-CREDIT", testCaseRevisionId: "REV-CREDIT", testCaseInstanceId: "INST-CREDIT", observedEngine: dimensions.browser,
      }, "RES-CREDIT", resultProvenance),
    ];
  }

  it("credits coverage from a runtime-execution (lane 1) test-result", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts(fixtureArtifacts("runtime-execution"));
    expect(result.ruleInputs.coverage.requiredMissing).toEqual([]);
  });

  it("credits coverage from a runtime-observed (lane 2) test-result", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts(fixtureArtifacts("runtime-observed"));
    expect(result.ruleInputs.coverage.requiredMissing).toEqual([]);
  });

  it("does not credit coverage from an agent-draft test-result", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts(fixtureArtifacts("agent-draft"));
    expect(result.ruleInputs.coverage.requiredMissing).toEqual(["COV-CREDIT"]);
  });

  it("does not credit coverage from an unrelated provenance value", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts(fixtureArtifacts("runtime"));
    expect(result.ruleInputs.coverage.requiredMissing).toEqual(["COV-CREDIT"]);
  });

  it("does not credit coverage from an undefined provenance", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts(fixtureArtifacts(undefined));
    expect(result.ruleInputs.coverage.requiredMissing).toEqual(["COV-CREDIT"]);
  });
});

describe("deriveReleaseGateFromWorkspaceArtifacts — test-result-batch coverage credit (Task 29)", () => {
  const dimensions = {
    requirementId: "REQ-CREDIT", role: "member", behavior: "save profile", browser: "chromium",
    viewport: { width: 1440, height: 900 }, risk: "high", outcome: "confirmation shown",
  };

  /** Planning artifacts plus one matching test case; the attempts are supplied per test. */
  function planning(): GateWorkspaceArtifact[] {
    return [
      artifact("requirement-analysis", { statements: [{ requirementId: dimensions.requirementId, authority: "AUTHORITATIVE" }] }, "RA-CREDIT"),
      artifact("coverage-obligation", { obligationId: "COV-CREDIT", requirementAnalysisArtifactId: "RA-CREDIT", required: true, executionSurface: "browser", ...dimensions }, "OBL-CREDIT"),
      artifact("test-case", { testCaseId: "TC-CREDIT", revisionId: "REV-CREDIT", instanceId: "INST-CREDIT", coverage: dimensions }, "TC-ART-CREDIT"),
    ];
  }

  function batch(provenance: string | undefined, entries: readonly Record<string, unknown>[]): GateWorkspaceArtifact {
    return artifact("test-result-batch", {
      executionId: "EXEC-CREDIT", commitSha: "b".repeat(40), specTreeSha256: "c".repeat(64), entries,
    }, "BATCH-CREDIT", provenance);
  }

  /** Since `test-result-batch` 3.0.0 an entry declares the surface it ran on and the geometry it ran
   *  at; this one reports exactly what the obligation requires, so these Task 29 pins keep asserting
   *  what they were written to assert (provenance and binding decide credit here, not dimensions). */
  const passingEntry = { entryId: "ENTRY-1", status: "PASSED", testCaseId: "TC-CREDIT", testCaseRevisionId: "REV-CREDIT", testCaseInstanceId: "INST-CREDIT", executionSurface: "browser", observedEngine: dimensions.browser, viewport: dimensions.viewport };

  it("credits coverage from a runtime-observed (lane 2) batch entry", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([...planning(), batch("runtime-observed", [passingEntry])]);

    expect(result.ruleInputs.coverage.requiredMissing).toEqual([]);
    expect(result.ruleInputs.coverage.requiredHighRisk).toEqual([{ obligationId: "COV-CREDIT", passed: true }]);
  });

  it.each(["agent-draft", "runtime", undefined])("does not credit coverage from a %s batch", (provenance) => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([...planning(), batch(provenance, [passingEntry])]);

    expect(result.ruleInputs.coverage.requiredMissing).toEqual(["COV-CREDIT"]);
  });

  it("credits only the entries that passed, and only those bound to exactly one registered test case", () => {
    const failed = { ...passingEntry, entryId: "ENTRY-FAILED", status: "FAILED" };
    const orphan = { ...passingEntry, entryId: "ENTRY-ORPHAN", testCaseRevisionId: "REV-GONE" };
    const withPassing = deriveReleaseGateFromWorkspaceArtifacts([...planning(), batch("runtime-observed", [failed, orphan, passingEntry])]);
    // Same batch minus the one passing, resolvable entry: neither of the other two may stand in for it.
    const withoutPassing = deriveReleaseGateFromWorkspaceArtifacts([...planning(), batch("runtime-observed", [failed, orphan])]);

    expect(withPassing.ruleInputs.coverage.requiredMissing).toEqual([]);
    expect(withoutPassing.ruleInputs.coverage.requiredMissing).toEqual(["COV-CREDIT"]);
    expect(withoutPassing.ruleInputs.coverage.requiredHighRisk).toEqual([{ obligationId: "COV-CREDIT", passed: false }]);
  });

  it("drops an orphan-only batch rather than crediting it", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([...planning(), batch("runtime-observed", [{ ...passingEntry, testCaseInstanceId: "INST-GONE" }])]);

    expect(result.ruleInputs.coverage.requiredMissing).toEqual(["COV-CREDIT"]);
  });

  it("keeps the per-attempt test-result path intact in a mixed workspace", () => {
    const perAttempt = artifact("test-result", {
      attemptId: "ATT-CREDIT", status: "PASSED", testCaseId: "TC-CREDIT", testCaseRevisionId: "REV-CREDIT", testCaseInstanceId: "INST-CREDIT", observedEngine: dimensions.browser,
    }, "RES-CREDIT", "runtime-execution");
    const mixed = deriveReleaseGateFromWorkspaceArtifacts([...planning(), perAttempt, batch("runtime-observed", [passingEntry])]);
    const perAttemptOnly = deriveReleaseGateFromWorkspaceArtifacts([...planning(), perAttempt]);

    expect(mixed.ruleInputs.coverage).toEqual(perAttemptOnly.ruleInputs.coverage);
    expect(mixed.recommendation).toBe(perAttemptOnly.recommendation);
    // The batch is still a workspace fact bound into the immutable gate snapshot.
    expect(mixed.sourceArtifacts.map((source) => source.type)).toContain("test-result-batch");
  });

  /** Byte-identity pin: a workspace with NO batch must produce exactly the gate it produced before
   *  `test-result-batch` existed. The literal below was captured from the pre-change code.
   *
   *  The fixture's `accessibilityMethod` was `"keyboard"` on both the obligation and the test case
   *  until CONTEXT.md:438 was enforced; it is `null` now. That is an INPUT change, not an expectation
   *  change — the expected literal below is byte-for-byte the one captured originally, because
   *  `accessibilityMethod` appears nowhere in a gate. The old fixture credited COV-SAVE by matching
   *  one declared label against another, which is precisely the defect; keeping it would have made
   *  this pin assert NOT_READY and stop pinning what it was written to pin (a satisfied browser
   *  obligation yielding a READY gate, unchanged by the arrival of `test-result-batch`). */
  it("produces byte-identical gate output for a workspace containing no batches", () => {
    const noBatch = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("requirement-analysis", { statements: [{ requirementId: "REQ-SAVE", authority: "AUTHORITATIVE" }] }, "RA-1"),
      artifact("coverage-obligation", {
        obligationId: "COV-SAVE", requirementAnalysisArtifactId: "RA-1", required: true, executionSurface: "browser",
        requirementId: "REQ-SAVE", role: "member", behavior: "save profile", browser: "chromium",
        viewport: { width: 1440, height: 900 }, accessibilityMethod: null, risk: "high", outcome: "confirmation shown",
      }, "OBL-1"),
      artifact("test-case", {
        testCaseId: "TC-SAVE", revisionId: "REV-SAVE", instanceId: "TC-SAVE--INSTANCE-1",
        coverage: {
          requirementId: "REQ-SAVE", role: "member", behavior: "save profile", browser: "chromium",
          viewport: { width: 1440, height: 900 }, accessibilityMethod: null, risk: "high", outcome: "confirmation shown",
        },
      }, "TC-1"),
      artifact("test-result", {
        attemptId: "ATTEMPT-SAVE", status: "PASSED", testCaseId: "TC-SAVE", testCaseRevisionId: "REV-SAVE", testCaseInstanceId: "TC-SAVE--INSTANCE-1", observedEngine: "chromium",
      }, "RES-1", "runtime-execution"),
    ]);

    expect(JSON.stringify(noBatch)).toBe("{\"recommendation\":\"READY\",\"ruleInputs\":{\"artifactsValid\":true,\"coverage\":{\"requiredMissing\":[],\"optionalGaps\":[],\"requiredHighRisk\":[{\"obligationId\":\"COV-SAVE\",\"passed\":true}]},\"bugs\":[],\"sharedBlockers\":[],\"incidents\":[],\"evidenceGaps\":[],\"cleanupLeaks\":[],\"unmappedChangeRisks\":[],\"validationDiagnostics\":[]},\"verdicts\":[{\"rule\":\"VALID_ARTIFACTS\",\"passed\":true,\"reason\":\"All registered artifacts are valid.\"},{\"rule\":\"NO_SHARED_BLOCKERS\",\"passed\":true,\"reason\":\"No shared blockers are present.\"},{\"rule\":\"NO_OPEN_BLOCKER_OR_CRITICAL\",\"passed\":true,\"reason\":\"No open Blocker or Critical product bug.\"},{\"rule\":\"NO_UNTRIAGED_PRODUCT_BUG\",\"passed\":true,\"reason\":\"No open untriaged product bug.\"},{\"rule\":\"REQUIRED_HIGH_RISK_PASSED\",\"passed\":true,\"reason\":\"All required high-risk obligations passed.\"},{\"rule\":\"REQUIRED_COVERAGE_COMPLETE\",\"passed\":true,\"reason\":\"All required coverage obligations are satisfied.\"},{\"rule\":\"NO_OPEN_PRODUCT_DEFECT_FOR_READY\",\"passed\":true,\"reason\":\"No open product defect remains.\"}],\"protectedEnvironment\":false,\"sourceArtifacts\":[{\"id\":\"OBL-1\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"type\":\"coverage-obligation\"},{\"id\":\"RA-1\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"type\":\"requirement-analysis\"},{\"id\":\"RES-1\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"type\":\"test-result\"},{\"id\":\"TC-1\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"type\":\"test-case\"}]}");
  });
});

/**
 * Task 36 — a batch entry's Execution Surface and viewport come from the ENTRY.
 *
 * This is the fail-OPEN reader, and unlike `evaluateWorkspaceCoverage`'s tests it is fed hand-built
 * records that no schema ever sees. That is exactly what is needed here: the pre-3.0.0 batch shape —
 * an entry with an `observedEngine` and NO surface and NO viewport of its own — is unregisterable now,
 * but it is still the shape that proves what the reader used to do with it. Every entry below is the
 * literal record a lane-2 producer would have written, and the obligation matches the bound test
 * case's DECLARED browser dimensions on every axis, so nothing but the entry's own surface and
 * viewport can decide the verdict.
 */
describe("deriveReleaseGateFromWorkspaceArtifacts — a batch entry's own Execution Surface and viewport (Task 36)", () => {
  /** The full browser coverage block the bound test case declares — on EVERY fixture here, including
   *  the non-browser ones, because `test-case.coverage` is browser-shaped by schema and that is
   *  precisely the declaration an entry must no longer be able to borrow. */
  const declared = {
    requirementId: "REQ-SURFACE", role: "member", behavior: "save profile", browser: "chromium",
    viewport: { width: 1440, height: 900 }, risk: "high", outcome: "confirmation shown",
  };
  /** The same block minus the two dimensions only the browser surface owns, for the non-browser rows. */
  const surfaceless = { requirementId: declared.requirementId, role: declared.role, behavior: declared.behavior, risk: declared.risk, outcome: declared.outcome };

  function planning(surface: string): GateWorkspaceArtifact[] {
    return [
      artifact("requirement-analysis", { statements: [{ requirementId: declared.requirementId, authority: "AUTHORITATIVE" }] }, "RA-SURFACE"),
      artifact("coverage-obligation", { obligationId: "COV-SURFACE", requirementAnalysisArtifactId: "RA-SURFACE", required: true, executionSurface: surface, ...(surface === "browser" ? declared : surfaceless) }, "OBL-SURFACE"),
      artifact("test-case", { testCaseId: "TC-SURFACE", revisionId: "REV-SURFACE", instanceId: "INST-SURFACE", coverage: declared }, "TC-ART-SURFACE"),
    ];
  }

  const entryIdentity = { entryId: "ENTRY-1", status: "PASSED", testCaseId: "TC-SURFACE", testCaseRevisionId: "REV-SURFACE", testCaseInstanceId: "INST-SURFACE" };
  const browserEntry = { ...entryIdentity, executionSurface: "browser", observedEngine: declared.browser, viewport: declared.viewport };

  /** The required obligations left unsatisfied when one runtime-observed entry is read against an
   *  obligation on `surface`. `[]` means the entry credited it; `["COV-SURFACE"]` means it did not. */
  function requiredMissing(surface: string, entry: Record<string, unknown>): readonly string[] {
    return deriveReleaseGateFromWorkspaceArtifacts([
      ...planning(surface),
      artifact("test-result-batch", { executionId: "EXEC-SURFACE", commitSha: "b".repeat(40), specTreeSha256: "c".repeat(64), entries: [entry] }, "BATCH-SURFACE", "runtime-observed"),
    ]).ruleInputs.coverage.requiredMissing;
  }

  /** THE test this task exists for. The entry says, in its own bytes, that an api suite ran — and it
   *  still carries the engine the 2.0.0 shape demanded of every entry, so nothing but the surface can
   *  be doing the work. Before this change the reader ignored that field, stamped the entry `browser`,
   *  handed it the test case's declared 1440x900, and credited a browser obligation no browser met. */
  it("does not let an api entry satisfy the browser obligation its bound test case declares dimensions for", () => {
    const gate = deriveReleaseGateFromWorkspaceArtifacts([
      ...planning("browser"),
      artifact("test-result-batch", { executionId: "EXEC-SURFACE", entries: [{ ...entryIdentity, executionSurface: "api", observedEngine: "chromium" }] }, "BATCH-SURFACE", "runtime-observed"),
    ]);

    expect(gate.ruleInputs.coverage.requiredMissing).toEqual(["COV-SURFACE"]);
    expect(gate.ruleInputs.coverage.requiredHighRisk).toEqual([{ obligationId: "COV-SURFACE", passed: false }]);
    expect(gate.recommendation).toBe("NOT_READY");
  });

  it("credits the same obligation from the same entry once it declares the browser surface it ran on", () => {
    expect(requiredMissing("browser", browserEntry)).toEqual([]);
  });

  it("credits a non-browser obligation from an entry that ran that same non-browser surface", () => {
    expect(requiredMissing("api", { ...entryIdentity, executionSurface: "api" })).toEqual([]);
  });

  it("does not let an entry on one non-browser surface satisfy an obligation on another", () => {
    expect(requiredMissing("api", { ...entryIdentity, executionSurface: "unit" })).toEqual(["COV-SURFACE"]);
  });

  it("does not credit a browser entry whose own viewport differs from the obligation's", () => {
    expect(requiredMissing("browser", { ...browserEntry, viewport: { width: 390, height: 844 } })).toEqual(["COV-SURFACE"]);
  });

  /** Fail-OPEN, unchanged in kind: a record this reader cannot resolve is DROPPED, which can only ever
   *  withhold credit. The first row is the pre-3.0.0 shape verbatim — the exact bytes that used to be
   *  stamped `browser` — and the point is that a reader with no surface to read now credits nothing
   *  rather than inventing one. */
  it.each([
    ["no Execution Surface at all (the pre-3.0.0 shape)", { ...entryIdentity, observedEngine: "chromium" }],
    ["a surface outside the enum", { ...browserEntry, executionSurface: "e2e" }],
    ["a browser surface with no viewport of its own", { ...entryIdentity, executionSurface: "browser", observedEngine: "chromium" }],
    ["a browser surface with no observed engine", { ...entryIdentity, executionSurface: "browser", viewport: declared.viewport }],
    ["a browser surface with a malformed viewport", { ...browserEntry, viewport: { width: 1440 } }],
  ] as const)("drops a batch entry declaring %s", (_label, entry) => {
    expect(requiredMissing("browser", entry)).toEqual(["COV-SURFACE"]);
  });

  /** Lane 1, unchanged: a `test-result` carries no surface and no viewport of its own and still credits
   *  a browser obligation matching the declaration, because `createBrowserAttemptSession` SET the live
   *  viewport from that declaration before the attempt ran. Both rows come off the same planning
   *  fixtures as the batch rows above, so a reader that started deriving lane 1 from the claim — or
   *  reading lane 2 from the test case — would break one of them. */
  it("still derives lane 1's surface and viewport from the declaration the runtime applied", () => {
    const result = (obligationViewport: { width: number; height: number }) => deriveReleaseGateFromWorkspaceArtifacts([
      artifact("requirement-analysis", { statements: [{ requirementId: declared.requirementId, authority: "AUTHORITATIVE" }] }, "RA-SURFACE"),
      artifact("coverage-obligation", { obligationId: "COV-SURFACE", requirementAnalysisArtifactId: "RA-SURFACE", required: true, executionSurface: "browser", ...declared, viewport: obligationViewport }, "OBL-SURFACE"),
      artifact("test-case", { testCaseId: "TC-SURFACE", revisionId: "REV-SURFACE", instanceId: "INST-SURFACE", coverage: declared }, "TC-ART-SURFACE"),
      artifact("test-result", { ...entryIdentity, entryId: undefined, attemptId: "ATT-SURFACE", observedEngine: declared.browser }, "RES-SURFACE", "runtime-execution"),
    ]).ruleInputs.coverage.requiredMissing;

    expect(result(declared.viewport)).toEqual([]);
    expect(result({ width: 390, height: 844 })).toEqual(["COV-SURFACE"]);
  });

  it("still refuses lane 1 credit for any non-browser obligation, because the runtime drove a browser", () => {
    const gate = deriveReleaseGateFromWorkspaceArtifacts([
      ...planning("api"),
      artifact("test-result", { ...entryIdentity, entryId: undefined, attemptId: "ATT-SURFACE", observedEngine: declared.browser }, "RES-SURFACE", "runtime-execution"),
    ]);

    expect(gate.ruleInputs.coverage.requiredMissing).toEqual(["COV-SURFACE"]);
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
