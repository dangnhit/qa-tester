import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { QaReportModel } from "../../src/reporting/report-model.js";
import { renderMarkdown } from "../../src/reporting/render-markdown.js";

const model: QaReportModel = { artifactType: "qa-execution-report", schemaVersion: "1.0.0", producerVersion: "0.1.0", runId: "run-golden", generatedAt: "2026-07-23T12:00:00.000Z", build: { identifier: "build-42" }, summary: "One product failure.", coverageMethods: ["browser"], incidents: [], bugs: [{ bugId: "BUG-CHECKOUT-AB12CD-001", severity: "Major" }], telemetryFindings: [{ kind: "console", level: "error", message: "request failed" }], evidenceGaps: [], cleanupLeaks: [], criticalFindings: [], remainingRisks: ["Manual accessibility not run"], excludedNotRun: ["Safari"], releaseGate: { recommendation: "READY_WITH_RISKS", ruleInputs: { artifactsValid: true, coverage: { requiredMissing: [], optionalGaps: [], requiredHighRisk: [] }, bugs: [], sharedBlockers: [] }, verdicts: [] } };

describe("report Markdown golden projections", () => {
  it.each(["en", "vi"] as const)("renders stable %s output from the shipped complete template", async (locale) => {
    const expected = await readFile(fileURLToPath(new URL(`../fixtures/report-golden.${locale}.md`, import.meta.url)), "utf8");
    expect(renderMarkdown(model, locale)).toBe(expected);
  });
});
