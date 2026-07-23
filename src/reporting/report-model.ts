import type { ReleaseGateResult } from "./release-gate.js";

export type QaReportModel = Readonly<{
  artifactType: "qa-execution-report";
  schemaVersion: "1.0.0";
  producerVersion: string;
  runId: string;
  generatedAt: string;
  build: Readonly<{ identifier: string }>;
  summary: string;
  coverageMethods: readonly string[];
  incidents: readonly Record<string, unknown>[];
  bugs: readonly Record<string, unknown>[];
  telemetryFindings: readonly Record<string, unknown>[];
  evidenceGaps: readonly Record<string, unknown>[];
  cleanupLeaks: readonly Record<string, unknown>[];
  criticalFindings: readonly string[];
  remainingRisks: readonly string[];
  excludedNotRun: readonly string[];
  releaseGate: ReleaseGateResult;
}>;

export function toQaExecutionReport(model: QaReportModel): Record<string, unknown> {
  return { ...model, releaseRecommendation: model.releaseGate.recommendation };
}
