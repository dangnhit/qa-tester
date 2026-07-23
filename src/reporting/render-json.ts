import { toQaExecutionReport, type QaReportModel } from "./report-model.js";

/** Canonical machine projection is stable, English-valued JSON. */
export function renderCanonicalJson(model: QaReportModel): string {
  return `${JSON.stringify(toQaExecutionReport(model), null, 2)}\n`;
}
