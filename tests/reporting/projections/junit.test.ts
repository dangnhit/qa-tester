import { describe, expect, it } from "vitest";

import { renderJUnit } from "../../../src/reporting/projections/junit.js";
import type { AttemptRow, ProjectionModel } from "../../../src/reporting/projections/projection-model.js";

// `provenance` defaults to "runtime-observed" -- a lane-2 value that DOES credit coverage
// (`creditsCoverage`, src/core/provenance.ts) -- so every baseline row in this file renders
// unprefixed, exactly as the assertions below expect. Only the provenance-label tests override it.
const attempt = (over: Partial<AttemptRow>): AttemptRow => ({
  lane: "observed-entry", id: "E-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1",
  status: "PASSED", failureClassification: "NONE", executionSurface: "api", durationMs: 1500, provenance: "runtime-observed", ...over,
});

const model = (over: Partial<ProjectionModel> = {}): ProjectionModel => ({
  runId: "RUN-1", producerVersion: "0.3.0", generatedAt: "2026-07-29T00:00:00.000Z", reduced: false,
  gate: { artifactId: "gate-1", sha256: "a".repeat(64), recommendation: "NOT_READY", verdicts: [
    { rule: "VALID_ARTIFACTS", passed: true, reason: "All registered artifacts are valid." },
    { rule: "REQUIRED_COVERAGE_COMPLETE", passed: false, reason: "Required coverage missing: COV-1." },
  ] },
  attempts: [], findings: [], sourceArtifacts: [], ...over,
});

describe("renderJUnit", () => {
  it("emits one testcase per gate verdict, failing exactly the verdicts that did not pass", () => {
    const xml = renderJUnit(model());
    expect(xml).toContain(`<testsuite name="qa-skills.gate" tests="2" failures="1" errors="0" skipped="0">`);
    expect(xml).toContain(`<testcase name="VALID_ARTIFACTS" classname="gate" time="0"/>`);
    expect(xml).toContain(`<failure message="Required coverage missing: COV-1."/>`);
  });

  it("maps every attempt status to its JUnit element, and counts the suite from the rows", () => {
    const xml = renderJUnit(model({ attempts: [
      attempt({ id: "E-1", status: "PASSED" }),
      attempt({ id: "E-2", status: "FAILED", failureClassification: "PRODUCT_DEFECT" }),
      attempt({ id: "E-3", status: "BLOCKED" }),
      attempt({ id: "E-4", status: "INCONCLUSIVE" }),
      attempt({ id: "E-5", status: "NOT_RUN", durationMs: 0 }),
    ] }));
    expect(xml).toContain(`<testsuite name="qa-skills.attempts" tests="5" failures="1" errors="2" skipped="1">`);
    expect(xml).toContain(`<failure message="failureClassification=PRODUCT_DEFECT"/>`);
    expect(xml).toContain(`<error message="status=BLOCKED"/>`);
    expect(xml).toContain(`<error message="status=INCONCLUSIVE"/>`);
    expect(xml).toContain(`<skipped/>`);
  });

  it("reports a lane-1 attempt on the browser surface and converts measured milliseconds to seconds", () => {
    const xml = renderJUnit(model({ attempts: [attempt({ lane: "driven-attempt", id: "ATT-1", executionSurface: "browser", durationMs: 1500 })] }));
    expect(xml).toContain(`<testcase name="TC-1 INST-1" classname="browser" time="1.5"/>`);
  });

  it("escapes every XML metacharacter, so a reason or a test case id cannot break the document", () => {
    const xml = renderJUnit(model({
      gate: { artifactId: "g", sha256: "a".repeat(64), recommendation: "NOT_READY", verdicts: [
        { rule: "NO_SHARED_BLOCKERS", passed: false, reason: `a & b < c > d " e ' f` },
      ] },
      attempts: [attempt({ testCaseId: `TC<1>`, testCaseInstanceId: `I"1'` })],
    }));
    expect(xml).toContain(`<failure message="a &amp; b &lt; c &gt; d &quot; e &apos; f"/>`);
    expect(xml).toContain(`<testcase name="TC&lt;1&gt; I&quot;1&apos;"`);
    expect(xml).not.toMatch(/message="[^"]*[<>&](?!(amp|lt|gt|quot|apos);)/);
  });

  it("emits no findings suite: a bug is not a test case", () => {
    const xml = renderJUnit(model({ findings: [{ ruleId: "open-bug", level: "error", id: "BUG-1", message: "open bug BUG-1, severity Critical" }] }));
    expect(xml).not.toContain("BUG-1");
    expect(xml.match(/<testsuite /g)).toHaveLength(2);
  });

  // Controller decision (not in the original brief): a JUnit <testcase> has no provenance field, so
  // without a marker an agent-drafted claim (`creditsCoverage` false) would render indistinguishable
  // from a runtime-observed one. This is a LABEL, not a filter -- both rows render, only the name of
  // the non-crediting one changes -- so the difference between them is exactly what this test asserts.
  it("labels a testcase whose provenance does not credit coverage, and leaves a crediting one unprefixed", () => {
    const xml = renderJUnit(model({ attempts: [
      attempt({ id: "E-1", provenance: "agent-draft" }),
      attempt({ id: "E-2", provenance: "runtime-execution" }),
    ] }));
    expect(xml).toContain(`<testcase name="[agent-draft] TC-1 INST-1" classname="api" time="1.5"/>`);
    expect(xml).toContain(`<testcase name="TC-1 INST-1" classname="api" time="1.5"/>`);
  });
});
