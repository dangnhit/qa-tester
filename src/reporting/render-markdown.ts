import type { QaReportModel } from "./report-model.js";

const labels = {
  en: { title: "QA Report", build: "Build", summary: "Summary", coverage: "Coverage methods", incidents: "Incidents", bugs: "Bugs", telemetry: "Telemetry findings", gaps: "Evidence Gaps", cleanup: "Cleanup leaks", critical: "Critical findings", risks: "Remaining risks", excluded: "Excluded / not run", protected: "Protected environment", release: "Release recommendation", none: "None" },
  vi: { title: "Báo cáo QA", build: "Bản dựng", summary: "Tóm tắt", coverage: "Phương pháp bao phủ", incidents: "Sự cố", bugs: "Lỗi", telemetry: "Phát hiện telemetry", gaps: "Khoảng trống bằng chứng", cleanup: "Rò rỉ dọn dẹp", critical: "Phát hiện nghiêm trọng", risks: "Rủi ro còn lại", excluded: "Loại trừ / chưa chạy", protected: "Môi trường được bảo vệ", release: "Khuyến nghị phát hành", none: "Không có" },
} as const;

/** Canonical (untranslated) English body for the protected-environment line, honest on both paths. */
const protectedLine = { yes: "Protected environment — evidence was redacted before persistence", no: "Not a protected environment" } as const;
type Locale = keyof typeof labels;

function item(value: unknown): string { return `- ${typeof value === "string" ? value : JSON.stringify(value)}`; }
function section(values: readonly unknown[], none: string): string { return values.length === 0 ? `- ${none}` : values.map(item).join("\n"); }

/** Markdown changes headings and labels only; canonical values are never translated. */
export function renderMarkdown(model: QaReportModel, locale: Locale): string {
  const l = labels[locale];
  const template = readFileSync(fileURLToPath(new URL(`../../shared/templates/report.${locale}.md`, import.meta.url)), "utf8");
  const values: Record<string, string> = {
    title: l.title, build_label: l.build, summary_label: l.summary, coverage_label: l.coverage, incidents_label: l.incidents, bugs_label: l.bugs, telemetry_label: l.telemetry, gaps_label: l.gaps, cleanup_label: l.cleanup, critical_label: l.critical, risks_label: l.risks, excluded_label: l.excluded, protected_label: l.protected, release_label: l.release,
    build: model.build.identifier, summary: model.summary, coverage: section(model.coverageMethods, l.none), incidents: section(model.incidents, l.none), bugs: section(model.bugs, l.none), telemetry: section(model.telemetryFindings, l.none), gaps: section(model.evidenceGaps, l.none), cleanup: section(model.cleanupLeaks, l.none), critical: section(model.criticalFindings, l.none), risks: section(model.remainingRisks, l.none), excluded: section(model.excludedNotRun, l.none), protected: model.protectedEnvironment ? protectedLine.yes : protectedLine.no, release: model.releaseGate.recommendation,
  };
  return `${template.replace(/{{([a-z_]+)}}/g, (_token, key: string) => values[key] ?? "")}`.replace(/\n?$/, "\n");
}
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
