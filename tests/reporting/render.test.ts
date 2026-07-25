import { describe, expect, it } from "vitest";

import { renderCanonicalJson } from "../../src/reporting/render-json.js";
import { renderMarkdown } from "../../src/reporting/render-markdown.js";
import type { QaReportModel } from "../../src/reporting/report-model.js";

const model: QaReportModel = {
  artifactType: "qa-execution-report", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: "run-report", generatedAt: "2026-07-23T12:00:00.000Z",
  build: { identifier: "build-42" }, summary: "One product failure.", coverageMethods: ["browser"], incidents: [], bugs: [{ bugId: "BUG-CHECKOUT-AB12CD-001", severity: "Major" }], telemetryFindings: [], evidenceGaps: [], cleanupLeaks: [], criticalFindings: [], remainingRisks: ["Manual accessibility not run"], excludedNotRun: ["Safari"], protectedEnvironment: false, releaseGate: { recommendation: "READY_WITH_RISKS", ruleInputs: { artifactsValid: true, coverage: { requiredMissing: [], optionalGaps: ["COV-OPTIONAL"], requiredHighRisk: [] }, bugs: [], sharedBlockers: [] }, verdicts: [] },
};

describe("report rendering", () => {
  it("renders canonical JSON in English and Markdown with only localized labels", () => {
    const json = renderCanonicalJson(model);
    expect(JSON.parse(json)).toMatchObject({ releaseRecommendation: "READY_WITH_RISKS", bugs: [{ severity: "Major" }] });
    const english = renderMarkdown(model, "en");
    const vietnamese = renderMarkdown(model, "vi");
    expect(english).toContain("# QA Report");
    expect(vietnamese).toContain("# Báo cáo QA");
    for (const value of ["READY_WITH_RISKS", "Major", "BUG-CHECKOUT-AB12CD-001", "build-42"]) {
      expect(english).toContain(value);
      expect(vietnamese).toContain(value);
    }
  });
});
