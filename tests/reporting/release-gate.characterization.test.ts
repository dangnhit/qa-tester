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
// This suite pins the behavior of `evaluateReleaseGate`,
// `deriveReleaseGateFromWorkspaceArtifacts`, and `deriveReleaseGateFromArtifacts`.
//
// The fail-OPEN drops it originally pinned are GONE (Phase 9 item 3.1/D9): a
// record the gate cannot read is no longer dropped in silence, it is reported as
// a gate diagnostic, and any diagnostic fails `VALID_ARTIFACTS`, which is a hard
// rule. Every pin below that used to assert READY (or READY_WITH_RISKS) over a
// malformed record now asserts NOT_READY, and the "Phase 3/D9 will change this"
// markers those pins carried are deleted — the change they promised is the one
// these lines now pin.
//
// Nothing here is reachable through registration: every field the gate can fail
// to read is schema-constrained (`coverage-obligation`, `test-result`,
// `test-result-batch`, `test-case.coverage`, `bug-report`, including the
// `allOf` that makes `severity` required for a TRIAGED bug), and
// `testResultRule`/`testResultBatchRule` additionally bind every claim to
// exactly one registered test case. These are hand-built records that no schema
// ever sees, which is what makes them the only way to reach these paths at all.
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

/** The gate's own word for a registered record it could not read, as `unreadableGateArtifact`
 *  (src/reporting/release-gate.ts) spells it. Written out once here rather than imported, so a change to
 *  the wording has to be made deliberately in both places. */
function unreadable(type: string, id: string): string {
  return `${type} ${id} is not readable by the release gate`;
}

describe("deriveReleaseGateFromWorkspaceArtifacts — unreadable records (fail-CLOSED)", () => {
  it("blocks on a malformed required-critical coverage obligation whose viewport height is missing", () => {
    // required: true + risk: critical, but viewport.height is absent, so `browserDimensions` refuses it
    // and no obligation can be resolved from this record. It therefore still cannot appear in
    // requiredMissing or requiredHighRisk — naming it there would need an obligation id this record does
    // not reliably carry — but it is now REPORTED rather than dropped, and the report fails
    // VALID_ARTIFACTS.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("coverage-obligation", {
        obligationId: "COV-CRIT", requirementId: "REQ-1", role: "member", behavior: "pay",
        executionSurface: "browser", browser: "chromium", risk: "critical", outcome: "charged", required: true,
        viewport: { width: 1440 },
      }, "OBL-1"),
    ]);
    expect(result.ruleInputs.coverage.requiredMissing).toEqual([]);
    expect(result.ruleInputs.coverage.requiredHighRisk).toEqual([]);
    expect(result.ruleInputs.validationDiagnostics).toEqual([unreadable("coverage-obligation", "OBL-1")]);
    expect(result.verdicts.find((verdict) => verdict.rule === "VALID_ARTIFACTS")).toMatchObject({ passed: false });
    expect(result.recommendation).toBe("NOT_READY");
  });

  it("blocks on a malformed required-critical coverage obligation whose outcome field is missing", () => {
    // viewport is well-formed, but a required string field (outcome) is absent, so the record fails the
    // field-parse guard in `resolveGateObligations`.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("coverage-obligation", {
        obligationId: "COV-CRIT2", requirementId: "REQ-1", role: "member", behavior: "pay",
        executionSurface: "browser", browser: "chromium", risk: "critical", required: true,
        viewport: { width: 1440, height: 900 },
      }, "OBL-2"),
    ]);
    expect(result.ruleInputs.coverage.requiredMissing).toEqual([]);
    expect(result.ruleInputs.coverage.requiredHighRisk).toEqual([]);
    expect(result.ruleInputs.validationDiagnostics).toEqual([unreadable("coverage-obligation", "OBL-2")]);
    expect(result.recommendation).toBe("NOT_READY");
  });

  it("blocks on a runtime test-result that fails the field-parse (missing status)", () => {
    // The attempt matches a registered test case, so it clears the dimensions guard in `asAttempt`, but a
    // required string field (status) is absent and the claim cannot be flattened into an attempt.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("test-case", {
        testCaseId: "TC-1", revisionId: "REV-1", instanceId: "INST-1",
        coverage: { requirementId: "REQ-1", role: "member", behavior: "pay", browser: "chromium", viewport: { width: 1440, height: 900 }, risk: "critical", outcome: "charged" },
      }, "TC-ART-1"),
      artifact("test-result", {
        attemptId: "ATT-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1", observedEngine: "chromium",
      }, "RES-1", "runtime-execution"),
    ]);
    expect(result.ruleInputs.validationDiagnostics).toEqual([unreadable("test-result", "RES-1")]);
    expect(result.recommendation).toBe("NOT_READY");
  });

  it("blocks on a runtime test-result whose test case cannot be found (missing dimensions)", () => {
    // No registered test case matches, so the claim fails the dimensions guard in `asAttempt`.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("test-result", {
        attemptId: "ATT-2", status: "PASSED", testCaseId: "TC-GHOST", testCaseRevisionId: "REV-GHOST", testCaseInstanceId: "INST-GHOST", observedEngine: "chromium",
      }, "RES-2", "runtime-execution"),
    ]);
    expect(result.ruleInputs.validationDiagnostics).toEqual([unreadable("test-result", "RES-2")]);
    expect(result.recommendation).toBe("NOT_READY");
  });

  /** The batch's own shape, not an entry's contents. `array()`/`.filter(isRecord)` used to swallow both of
   *  these, and the BATCH is what gets named because an entry that is not an object has no id to name. */
  it.each([
    ["entries that are not an array at all", { executionId: "EXEC-1", entries: "ENTRY-1" }],
    ["an entry that is not an object", { executionId: "EXEC-1", entries: ["ENTRY-1"] }],
  ] as const)("blocks on a runtime-observed batch declaring %s", (_label, value) => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([artifact("test-result-batch", value, "BATCH-SHAPE", "runtime-observed")]);
    expect(result.ruleInputs.validationDiagnostics).toEqual([unreadable("test-result-batch", "BATCH-SHAPE")]);
    expect(result.recommendation).toBe("NOT_READY");
  });

  /** An EMPTY entry list is not malformed — it credits nothing and says nothing this reader cannot read.
   *  Without this row the two above would pass on a reader that refused every batch with no attempts. */
  it("does not block on a runtime-observed batch whose entry list is empty", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([artifact("test-result-batch", { executionId: "EXEC-1", entries: [] }, "BATCH-EMPTY", "runtime-observed")]);
    expect(result.ruleInputs.validationDiagnostics).toEqual([]);
    expect(result.recommendation).toBe("READY");
  });

  it("blocks on an open Critical bug report whose open field is not a boolean", () => {
    // The bug is an open TRIAGED Critical blocker, but `open` is a string, so the record cannot become a
    // GateBug at all. It stays out of `bugs` — this reader still refuses to guess what it says — and the
    // gate now says it could not read it.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("bug-report", { bugId: "BUG-1", triageStatus: "TRIAGED", severity: "Critical", open: "true" }, "BUG-ART-1"),
    ]);
    expect(result.ruleInputs.bugs).toEqual([]);
    expect(result.ruleInputs.validationDiagnostics).toEqual([unreadable("bug-report", "BUG-ART-1")]);
    expect(result.recommendation).toBe("NOT_READY");
  });

  it("blocks on an open Critical bug report whose triageStatus is not a known value", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("bug-report", { bugId: "BUG-2", triageStatus: "CLOSED", severity: "Critical", open: true }, "BUG-ART-2"),
    ]);
    expect(result.ruleInputs.bugs).toEqual([]);
    expect(result.ruleInputs.validationDiagnostics).toEqual([unreadable("bug-report", "BUG-ART-2")]);
    expect(result.recommendation).toBe("NOT_READY");
  });

  it("blocks on a bug report that has no bugId", () => {
    // Without a bugId the record cannot even enter the latest-revision map, so an open Critical blocker
    // never reaches `bugs`; the skip is now reported.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("bug-report", { triageStatus: "TRIAGED", severity: "Critical", open: true }, "BUG-ART-3"),
    ]);
    expect(result.ruleInputs.bugs).toEqual([]);
    expect(result.ruleInputs.validationDiagnostics).toEqual([unreadable("bug-report", "BUG-ART-3")]);
    expect(result.recommendation).toBe("NOT_READY");
  });
});

describe("deriveReleaseGateFromWorkspaceArtifacts — a TRIAGED bug's severity (fail-CLOSED)", () => {
  it("blocks on an open TRIAGED bug with no severity rather than treating it as a mere risk", () => {
    // `bug-report.schema.json`'s allOf makes `severity` REQUIRED for a TRIAGED bug, so this record cannot
    // be registered. When one reaches this reader anyway, "TRIAGED with no severity" is a severity this
    // reader cannot map — not a Blocker, not a Minor — and the safe reading of that is "unreadable",
    // never "harmless". The bug itself is still reported exactly as read.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("bug-report", { bugId: "BUG-SEV", triageStatus: "TRIAGED", open: true }, "BUG-ART-4"),
    ]);
    expect(result.ruleInputs.bugs).toEqual([{ bugId: "BUG-SEV", triageStatus: "TRIAGED", open: true }]);
    expect(result.ruleInputs.validationDiagnostics).toEqual([unreadable("bug-report", "BUG-ART-4")]);
    expect(result.recommendation).toBe("NOT_READY");
  });

  it("blocks on an open TRIAGED bug with an unrecognized severity value", () => {
    // An out-of-enum severity ("Catastrophic") is still stripped from the reported bug — inventing a
    // meaning for it is exactly what must not happen — but the gate no longer pretends it read it.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("bug-report", { bugId: "BUG-SEV2", triageStatus: "TRIAGED", severity: "Catastrophic", open: true }, "BUG-ART-5"),
    ]);
    expect(result.ruleInputs.bugs).toEqual([{ bugId: "BUG-SEV2", triageStatus: "TRIAGED", open: true }]);
    expect(result.ruleInputs.validationDiagnostics).toEqual([unreadable("bug-report", "BUG-ART-5")]);
    expect(result.recommendation).toBe("NOT_READY");
  });

  /** The other side of the same rule: a severity this reader DOES recognise still makes the bug a mere
   *  risk. Without this row the two above would pass on a reader that simply refused every TRIAGED bug. */
  it("still treats an open TRIAGED Major bug as a risk, with nothing unreadable about it", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("bug-report", { bugId: "BUG-SEV3", triageStatus: "TRIAGED", severity: "Major", open: true }, "BUG-ART-6"),
    ]);
    expect(result.ruleInputs.validationDiagnostics).toEqual([]);
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
 * This is the reader that REPORTS rather than throws, and unlike `evaluateWorkspaceCoverage`'s tests it
 * is fed hand-built records that no schema ever sees. That is exactly what is needed here: the
 * pre-3.0.0 batch shape —
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

  /** Pins `matchesObligation`'s surface-EQUALITY check, not a non-browser-specific mis-credit guard: a
   *  `unit` entry stamped `browser` (i.e. the feature this task adds removed) would ALSO fail to match
   *  an `api` obligation, so this test alone does not prove the entry's surface is what is being read —
   *  only that mismatched surfaces never match. The rows above it are what prove the read. */
  it("requires an entry's execution surface to equal the obligation's exactly (surface-equality pin, not a mis-credit guard)", () => {
    expect(requiredMissing("api", { ...entryIdentity, executionSurface: "unit" })).toEqual(["COV-SURFACE"]);
  });

  it("does not credit a browser entry whose own viewport differs from the obligation's", () => {
    expect(requiredMissing("browser", { ...browserEntry, viewport: { width: 390, height: 844 } })).toEqual(["COV-SURFACE"]);
  });

  /** Unchanged in kind: an entry this reader cannot resolve credits NOTHING, which is all these rows
   *  assert. Since the fail-CLOSED flip it also makes the batch an unreadable record, so each of these
   *  gates is additionally NOT_READY — pinned by its own rows in the fail-CLOSED suite above rather than
   *  restated here, because what THIS task is about is the missing credit. The first row is the
   *  pre-3.0.0 shape verbatim — the exact bytes that used to be stamped `browser` — and the point is
   *  that a reader with no surface to read invents nothing. */
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

describe("deriveReleaseGateFromArtifacts — incident/evidence-gap/cleanup inputs (fail-CLOSED)", () => {
  it("folds incidents, evidenceGaps, and cleanupLeaks into shared blockers, exactly as the workspace variant does", () => {
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
    // The three inputs this function has always ACCEPTED are now the three inputs it READS. They are
    // phrased by the one shared reader both derivations use, so the sibling gate cannot disagree with the
    // workspace one about what an environment incident means.
    expect(result.ruleInputs.sharedBlockers).toEqual([
      "Cleanup leak LEAK-1",
      "Environment incident INC-1",
      "Evidence gap GAP-1 affects video capture",
    ]);
    expect(result.sourceArtifacts).toEqual([{ id: "ART-1", sha256: "a".repeat(64), type: "test-case" }]);
    expect(result.recommendation).toBe("NOT_READY");
  });

  /** A non-environment incident is still not a shared blocker — the workspace variant filters on
   *  `kind === "ENVIRONMENT_INCIDENT"` and this one must filter identically, or the two derivations
   *  disagree in the other direction. */
  it("does not fold a non-environment incident into a shared blocker", () => {
    const result = deriveReleaseGateFromArtifacts({
      artifactRecords: [],
      coverage: passing.coverage,
      bugs: [],
      incidents: [{ incidentId: "INC-2", kind: "TEST_INCIDENT" }],
      evidenceGaps: [],
      cleanupLeaks: [],
      sharedBlockers: [],
      artifactsValid: true,
    });
    expect(result.ruleInputs.sharedBlockers).toEqual([]);
    expect(result.recommendation).toBe("READY");
  });

  it("agrees with the workspace variant on an equivalent evidence gap (NOT_READY)", () => {
    // The convergence the row above describes: the same evidence-gap fact is a hard shared blocker on
    // both paths, phrased the same way.
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      artifact("evidence-gap", { evidenceGapId: "GAP-1", affectedClaim: "video capture" }, "GAP-ART-1"),
    ]);
    expect(result.ruleInputs.sharedBlockers.length).toBeGreaterThan(0);
    expect(result.recommendation).toBe("NOT_READY");
  });
});
