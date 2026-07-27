import { describe, expect, it } from "vitest";

import { deriveReleaseGateFromWorkspaceArtifacts, evaluateReleaseGate } from "../../src/reporting/release-gate.js";

const passing = { artifactsValid: true, coverage: { requiredMissing: [], optionalGaps: [], requiredHighRisk: [{ obligationId: "COV-PAY", passed: true }] }, bugs: [], sharedBlockers: [] };

describe("evaluateReleaseGate", () => {
  it("records every deterministic rule input and blocks invalid artifacts, shared blockers, critical defects, untriaged bugs, coverage, and high-risk failures", () => {
    for (const input of [
      { ...passing, artifactsValid: false },
      { ...passing, sharedBlockers: ["database unavailable"] },
      { ...passing, bugs: [{ bugId: "BUG-1", triageStatus: "TRIAGED" as const, severity: "Critical" as const, open: true }] },
      { ...passing, bugs: [{ bugId: "BUG-2", triageStatus: "NEEDS_TRIAGE" as const, open: true }] },
      { ...passing, coverage: { ...passing.coverage, requiredMissing: ["COV-REQUIRED"] } },
      { ...passing, coverage: { ...passing.coverage, requiredHighRisk: [{ obligationId: "COV-PAY", passed: false }] } },
    ]) expect(evaluateReleaseGate(input).recommendation).toBe("NOT_READY");
  });

  it("distinguishes acceptable risk from ready", () => {
    expect(evaluateReleaseGate({ ...passing, coverage: { ...passing.coverage, optionalGaps: ["COV-OPTIONAL"] } }).recommendation).toBe("READY_WITH_RISKS");
    expect(evaluateReleaseGate({ ...passing, bugs: [{ bugId: "BUG-3", triageStatus: "TRIAGED", severity: "Major", open: true }] }).recommendation).toBe("READY_WITH_RISKS");
    expect(evaluateReleaseGate(passing)).toMatchObject({ recommendation: "READY", ruleInputs: passing });
  });

  /** THE PROMISE (CONTEXT.md:445): "An Execution Surface that no executor covers still produces
   *  authorable obligations, which remain explicitly unmet rather than absent." Before Task 32 an
   *  obligation with no viewport was silently DROPPED by the gate's obligation resolution, so a
   *  non-browser obligation would have vanished from every coverage bucket and left the run READY.
   *  It must instead arrive in `requiredMissing` and block the release. */
  it("keeps a required obligation on an unexecutable surface explicitly unmet, never absent", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      {
        record: { id: "RA-API", sha256: "a".repeat(64), type: "requirement-analysis" },
        value: { statements: [{ requirementId: "REQ-API", authority: "AUTHORITATIVE" }] },
      },
      {
        record: { id: "OBL-API", sha256: "a".repeat(64), type: "coverage-obligation" },
        // No `browser`, no `viewport`: the api surface has neither, and the schema forbids both.
        value: {
          obligationId: "COV-API", requirementId: "REQ-API", requirementAnalysisArtifactId: "RA-API",
          executionSurface: "api", role: "member", behavior: "save profile",
          risk: "critical", required: true, outcome: "confirmation shown",
        },
      },
    ]);

    expect(result.ruleInputs.coverage.requiredMissing).toEqual(["COV-API"]);
    expect(result.ruleInputs.coverage.requiredHighRisk).toEqual([{ obligationId: "COV-API", passed: false }]);
    expect(result.verdicts.find((verdict) => verdict.rule === "REQUIRED_COVERAGE_COMPLETE")).toMatchObject({ passed: false });
    expect(result.recommendation).toBe("NOT_READY");
  });

  it("surfaces an unexecutable OPTIONAL obligation as a risk gap rather than dropping it", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      {
        record: { id: "OBL-PERF", sha256: "a".repeat(64), type: "coverage-obligation" },
        value: {
          obligationId: "COV-PERF", requirementId: "REQ-PERF", requirementAnalysisArtifactId: "RA-PERF",
          executionSurface: "performance", role: "member", behavior: "save profile",
          risk: "low", required: false, outcome: "under 200ms",
        },
      },
    ]);

    expect(result.ruleInputs.coverage.optionalGaps).toEqual(["COV-PERF"]);
    expect(result.recommendation).toBe("READY_WITH_RISKS");
  });

  /** The boundary this task turns on: "declares a surface the runtime cannot execute" is VALID and
   *  must be counted; "declares something that is not a surface at all" is MALFORMED and keeps falling
   *  through the gate's pre-existing, deliberately-deferred fail-OPEN drop. Do not conflate them. */
  it("drops an obligation whose executionSurface is not a surface at all, as it drops any malformed record", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      {
        record: { id: "OBL-BAD", sha256: "a".repeat(64), type: "coverage-obligation" },
        value: {
          obligationId: "COV-BAD", requirementId: "REQ-1", requirementAnalysisArtifactId: "RA-1",
          executionSurface: "smoke", role: "member", behavior: "pay",
          risk: "critical", required: true, outcome: "charged",
        },
      },
    ]);

    expect(result.ruleInputs.coverage.requiredMissing).toEqual([]);
    expect(result.ruleInputs.coverage.requiredHighRisk).toEqual([]);
    // Same fail-OPEN policy as every other malformed obligation; Phase 3/D9 owns flipping it.
    expect(result.recommendation).toBe("READY");
  });

  // RENAMED (was "does not let a browser attempt credit an obligation on a different surface"): this is
  // an END-TO-END CHARACTERIZATION, not an isolation of the surface check. The resolver above always
  // drops `browser`/`viewport` for a non-browser obligation (`geometry = surface === "browser" ?
  // browserDimensions(value) : {}`), so the derived attempt's `browser: "chromium"` can never equal this
  // obligation's `browser: undefined` — even matching stripped of all surface-awareness would still
  // reject this pair, for that reason alone. What isolates the surface check itself, with that confound
  // removed by smuggling matching geometry onto a plain object, is `tests/planning/coverage.test.ts`'s
  // "does not let a browser attempt satisfy a non-browser obligation matching on every other dimension"
  // and "decides on the surface alone, even when browser dimensions would otherwise line up exactly".
  // This test still earns its place: it pins the full `deriveReleaseGateFromWorkspaceArtifacts` pipeline's
  // observable outcome (NOT_READY, COV-API missing), which those unit tests never exercise.
  it("does not let a browser attempt credit an obligation on a different surface, end to end", () => {
    const dimensions = {
      requirementId: "REQ-API", role: "member", behavior: "save profile", browser: "chromium",
      viewport: { width: 1440, height: 900 }, risk: "high", outcome: "confirmation shown",
    };
    const result = deriveReleaseGateFromWorkspaceArtifacts([
      {
        record: { id: "RA-API", sha256: "a".repeat(64), type: "requirement-analysis" },
        value: { statements: [{ requirementId: "REQ-API", authority: "AUTHORITATIVE" }] },
      },
      {
        record: { id: "OBL-API", sha256: "a".repeat(64), type: "coverage-obligation" },
        value: {
          obligationId: "COV-API", requirementAnalysisArtifactId: "RA-API", required: true,
          executionSurface: "api", requirementId: dimensions.requirementId, role: dimensions.role,
          behavior: dimensions.behavior, risk: dimensions.risk, outcome: dimensions.outcome,
        },
      },
      {
        record: { id: "TC-API", sha256: "a".repeat(64), type: "test-case" },
        value: { testCaseId: "TC-1", revisionId: "REV-1", instanceId: "INST-1", coverage: dimensions },
      },
      {
        record: { id: "RES-API", sha256: "a".repeat(64), type: "test-result", provenance: "runtime-execution" },
        value: { attemptId: "ATT-1", status: "PASSED", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1" },
      },
    ]);

    expect(result.ruleInputs.coverage.requiredMissing).toEqual(["COV-API"]);
    expect(result.recommendation).toBe("NOT_READY");
  });

  /** CONTEXT.md:442 — the gate credits a Browser Matrix member from the engine the QA Runtime OBSERVED,
   *  never from the engine a test case declared. Before this change `asAttempt` sourced the attempt's
   *  engine from `test-case.coverage.browser`, so the gate compared the obligation's declaration
   *  against the test case's declaration and the execution was never consulted at all. */
  describe("observed engine", () => {
    const declared = {
      requirementId: "REQ-SAVE", role: "member", behavior: "save profile", browser: "chromium",
      viewport: { width: 1440, height: 900 }, risk: "high", outcome: "confirmation shown",
    };
    /** One authoritative required browser obligation, one matching test case, one passing attempt. */
    const workspace = (obligationBrowser: string, result: Record<string, unknown>) => [
      { record: { id: "RA-1", sha256: "a".repeat(64), type: "requirement-analysis" }, value: { statements: [{ requirementId: "REQ-SAVE", authority: "AUTHORITATIVE" }] } },
      {
        record: { id: "OBL-1", sha256: "a".repeat(64), type: "coverage-obligation" },
        value: { ...declared, obligationId: "COV-SAVE", requirementAnalysisArtifactId: "RA-1", executionSurface: "browser", required: true, browser: obligationBrowser },
      },
      { record: { id: "TC-1", sha256: "a".repeat(64), type: "test-case" }, value: { testCaseId: "TC-SAVE", revisionId: "REV-1", instanceId: "INST-1", coverage: declared } },
      {
        record: { id: "RES-1", sha256: "a".repeat(64), type: "test-result", provenance: "runtime-execution" },
        value: { attemptId: "ATT-1", status: "PASSED", testCaseId: "TC-SAVE", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1", ...result },
      },
    ];

    it("does not credit a chromium obligation from an attempt that observed firefox, though the test case declares chromium", () => {
      const result = deriveReleaseGateFromWorkspaceArtifacts(workspace("chromium", { observedEngine: "firefox" }));

      expect(result.ruleInputs.coverage.requiredMissing).toEqual(["COV-SAVE"]);
      expect(result.recommendation).toBe("NOT_READY");
    });

    it("credits a firefox obligation from an attempt that observed firefox, though the test case declares chromium", () => {
      const result = deriveReleaseGateFromWorkspaceArtifacts(workspace("firefox", { observedEngine: "firefox" }));

      expect(result.ruleInputs.coverage.requiredMissing).toEqual([]);
      expect(result.ruleInputs.coverage.requiredHighRisk).toEqual([{ obligationId: "COV-SAVE", passed: true }]);
      expect(result.recommendation).toBe("READY");
    });

    it("drops an attempt that records no observed engine rather than falling back to the declared one", () => {
      // The `test-result` schema requires `observedEngine`, so a registered artifact always carries it;
      // this reader is nonetheless the fail-OPEN one and takes unvalidated records. A missing engine
      // must DROP the attempt (leaving the obligation unmet) and never silently re-read the test case's
      // label, which here would agree with the obligation and manufacture a credit.
      const result = deriveReleaseGateFromWorkspaceArtifacts(workspace("chromium", {}));

      expect(result.ruleInputs.coverage.requiredMissing).toEqual(["COV-SAVE"]);
      expect(result.recommendation).toBe("NOT_READY");
    });
  });

  it("never recommends READY while an Evidence Gap leaves a claim unsubstantiated", () => {
    const result = deriveReleaseGateFromWorkspaceArtifacts([{
      record: { id: "GAP-1", sha256: "a".repeat(64), type: "evidence-gap" },
      value: {
        artifactType: "evidence-gap",
        schemaVersion: "1.0.0",
        producerVersion: "0.1.0",
        evidenceGapId: "GAP-1",
        runId: "RUN-1",
        scope: "operational",
        reason: "Required video could not be captured.",
        affectedClaim: "video capture",
      },
    }]);

    expect(result.recommendation).toBe("NOT_READY");
    expect(result.ruleInputs.sharedBlockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/evidence gap.*video capture/i),
    ]));
  });

  /**
   * CONTEXT.md:438-439 through the LIVE gate. An unmet Accessibility Obligation must reach the
   * coverage buckets and drive the recommendation exactly as Task 32's unexecutable surfaces do —
   * verified here rather than assumed to fall out.
   *
   * The obligation is on the BROWSER surface deliberately: every other dimension (surface, engine,
   * geometry, requirement, role, behavior, risk, outcome) lines up perfectly with a passing attempt,
   * so the accessibility rule is the only thing that can decide these cases. A `manual`-surface
   * obligation would already be rejected by the surface check and prove nothing.
   */
  describe("accessibility obligations", () => {
    const dimensions = {
      requirementId: "REQ-A11Y", role: "member", behavior: "complete checkout", browser: "chromium",
      viewport: { width: 1440, height: 900 }, risk: "critical", outcome: "Order confirmation is shown",
    };
    // Distinct per artifact, unlike this suite's usual "a".repeat(64) filler: an attestation names the
    // exact immutable BYTES of the obligation it attests to, so a shared checksum would let one
    // attestation stand for every obligation in the workspace and hide the binding entirely.
    const obligationSha256 = "b".repeat(64);
    const attestation = (obligationChecksum: string, provenance = "human-attestation:reviewer@example.test") => ({
      record: { id: "ATT-A11Y", sha256: "e".repeat(64), type: "human-attestation", provenance },
      value: {
        artifactType: "human-attestation", schemaVersion: "1.0.0", producerVersion: "1.0.0", attestationId: "ATTESTATION-1",
        runId: "RUN-1", obligationId: "COV-A11Y", obligationSha256: obligationChecksum, method: "screen-reader",
        attestedBy: "reviewer@example.test", attestedAt: "2026-07-25T09:00:00.000Z",
        statement: "Drove the whole checkout flow with VoiceOver; every control was announced with its role and current state.",
      },
    });
    /** One authoritative obligation declaring `method`, one matching test case, one passing attempt. */
    const workspace = (method: string, options: { required?: boolean; attested?: string; attestedProvenance?: string; omitResult?: boolean } = {}) => [
      { record: { id: "RA-A11Y", sha256: "a".repeat(64), type: "requirement-analysis" }, value: { statements: [{ requirementId: "REQ-A11Y", authority: "AUTHORITATIVE" }] } },
      {
        record: { id: "OBL-A11Y", sha256: obligationSha256, type: "coverage-obligation" },
        value: { ...dimensions, obligationId: "COV-A11Y", requirementAnalysisArtifactId: "RA-A11Y", executionSurface: "browser", required: options.required ?? true, accessibilityMethod: method },
      },
      { record: { id: "TC-A11Y", sha256: "c".repeat(64), type: "test-case" }, value: { testCaseId: "TC-1", revisionId: "REV-1", instanceId: "INST-1", coverage: { ...dimensions, accessibilityMethod: method } } },
      ...(options.omitResult === true ? [] : [{
        record: { id: "RES-A11Y", sha256: "d".repeat(64), type: "test-result", provenance: "runtime-execution" },
        value: { attemptId: "ATT-1", status: "PASSED", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1", observedEngine: "chromium" },
      }]),
      ...(options.attested === undefined ? [] : [attestation(options.attested, options.attestedProvenance)]),
    ];

    it("blocks the release on a required screen-reader obligation that no attestation covers", () => {
      const result = deriveReleaseGateFromWorkspaceArtifacts(workspace("screen-reader"));

      expect(result.ruleInputs.coverage.requiredMissing).toEqual(["COV-A11Y"]);
      expect(result.ruleInputs.coverage.requiredHighRisk).toEqual([{ obligationId: "COV-A11Y", passed: false }]);
      expect(result.verdicts.find((verdict) => verdict.rule === "REQUIRED_COVERAGE_COMPLETE")).toMatchObject({ passed: false });
      expect(result.recommendation).toBe("NOT_READY");
    });

    it("clears the same obligation from a Human Attestation naming its exact bytes, with no attempt at all", () => {
      // No `test-result` whatsoever: the attestation is unambiguously the thing doing the work here,
      // not a bystander next to a passing attempt that would have credited the obligation anyway.
      const result = deriveReleaseGateFromWorkspaceArtifacts(workspace("screen-reader", { attested: obligationSha256, omitResult: true }));

      expect(result.ruleInputs.coverage.requiredMissing).toEqual([]);
      expect(result.ruleInputs.coverage.requiredHighRisk).toEqual([{ obligationId: "COV-A11Y", passed: true }]);
      expect(result.recommendation).toBe("READY");
      // The artifact that earned the credit is bound into the immutable gate snapshot.
      expect(result.sourceArtifacts.map((source) => source.type)).toContain("human-attestation");
    });

    it("does not clear it from an attestation naming some other obligation's bytes", () => {
      const result = deriveReleaseGateFromWorkspaceArtifacts(workspace("screen-reader", { attested: "f".repeat(64) }));

      expect(result.ruleInputs.coverage.requiredMissing).toEqual(["COV-A11Y"]);
      expect(result.recommendation).toBe("NOT_READY");
    });

    /** The provenance guard, mirroring `creditsCoverage` on the attempt paths. Everything else about
     *  these payloads is perfect — the exact obligation bytes, the exact method, a substantive
     *  statement — so only the manifest stamp can decide them. `agent-draft` is the value
     *  `registerArtifactValue` defaults to when nothing stamps a provenance, i.e. exactly what an
     *  attestation payload that did not come from `recordHumanAttestation` would carry.
     *  Fail-OPEN is preserved: the record is dropped, never thrown on. */
    it.each(["agent-draft", "runtime", "runtime-execution", "human-approval:qa-lead", "human-attestation:"])(
      "does not clear it from an attestation stamped %s instead of human-attestation:<identity>",
      (provenance) => {
        const result = deriveReleaseGateFromWorkspaceArtifacts(workspace("screen-reader", { attested: obligationSha256, attestedProvenance: provenance, omitResult: true }));

        expect(result.ruleInputs.coverage.requiredMissing).toEqual(["COV-A11Y"]);
        expect(result.ruleInputs.coverage.requiredHighRisk).toEqual([{ obligationId: "COV-A11Y", passed: false }]);
        expect(result.recommendation).toBe("NOT_READY");
      },
    );

    it("reports an unattested OPTIONAL accessibility obligation as a risk gap rather than dropping it", () => {
      const result = deriveReleaseGateFromWorkspaceArtifacts(workspace("keyboard", { required: false }));

      expect(result.ruleInputs.coverage.optionalGaps).toEqual(["COV-A11Y"]);
      expect(result.ruleInputs.coverage.requiredMissing).toEqual([]);
      expect(result.recommendation).toBe("READY_WITH_RISKS");
    });

    it("blocks the release on a required automated-analysis obligation, which nothing in this repo can satisfy", () => {
      const result = deriveReleaseGateFromWorkspaceArtifacts(workspace("automated-analysis"));

      expect(result.ruleInputs.coverage.requiredMissing).toEqual(["COV-A11Y"]);
      expect(result.recommendation).toBe("NOT_READY");
    });

    it("still credits a null-method obligation from the passing attempt, with nothing attested", () => {
      // The common case, unaffected: `accessibilityMethod: null` is not an Accessibility Obligation.
      const result = deriveReleaseGateFromWorkspaceArtifacts(workspace(null as unknown as string));

      expect(result.ruleInputs.coverage.requiredMissing).toEqual([]);
      expect(result.recommendation).toBe("READY");
    });
  });
});
