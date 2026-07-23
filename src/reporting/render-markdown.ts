import type { QaReportModel } from "./report-model.js";

const labels = {
  en: { title: "QA Report", build: "Build", summary: "Summary", coverage: "Coverage methods", incidents: "Incidents", bugs: "Bugs", telemetry: "Telemetry findings", gaps: "Evidence Gaps", cleanup: "Cleanup leaks", critical: "Critical findings", risks: "Remaining risks", excluded: "Excluded / not run", release: "Release recommendation" },
  vi: { title: "Báo cáo QA", build: "Bản dựng", summary: "Tóm tắt", coverage: "Phương pháp bao phủ", incidents: "Sự cố", bugs: "Lỗi", telemetry: "Phát hiện telemetry", gaps: "Khoảng trống bằng chứng", cleanup: "Rò rỉ dọn dẹp", critical: "Phát hiện nghiêm trọng", risks: "Rủi ro còn lại", excluded: "Loại trừ / chưa chạy", release: "Khuyến nghị phát hành" },
} as const;
type Locale = keyof typeof labels;

function item(value: unknown): string { return `- ${typeof value === "string" ? value : JSON.stringify(value)}`; }
function section(heading: string, values: readonly unknown[]): string { return `## ${heading}\n${values.length === 0 ? "- None" : values.map(item).join("\n")}`; }

/** Markdown changes headings and labels only; canonical values are never translated. */
export function renderMarkdown(model: QaReportModel, locale: Locale): string {
  const l = labels[locale];
  return [
    `# ${l.title}`, `## ${l.build}\n${model.build.identifier}`, `## ${l.summary}\n${model.summary}`,
    section(l.coverage, model.coverageMethods), section(l.incidents, model.incidents), section(l.bugs, model.bugs),
    section(l.telemetry, model.telemetryFindings), section(l.gaps, model.evidenceGaps), section(l.cleanup, model.cleanupLeaks),
    section(l.critical, model.criticalFindings), section(l.risks, model.remainingRisks), section(l.excluded, model.excludedNotRun),
    `## ${l.release}\n${model.releaseGate.recommendation}`,
  ].join("\n\n") + "\n";
}
