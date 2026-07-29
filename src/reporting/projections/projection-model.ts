import { QaSkillsError } from "../../core/errors.js";
import { isRecord } from "../../core/values.js";

/** The artifact shape a projection reads. Declared structurally, not imported from `RunWorkspace`, for
 *  the same reason `release-gate.ts` declares `GateWorkspaceArtifact` locally: these modules are pure
 *  reducers over already-read records and must not acquire a dependency on the reader. */
export type ProjectionArtifact = Readonly<{
  record: Readonly<{ id: string; sha256: string; type: string; provenance?: string }>;
  value: Readonly<Record<string, unknown>>;
}>;

export type ProjectionLocation = Readonly<{ file: string; line?: number }>;

export type AttemptRow = Readonly<{
  lane: "driven-attempt" | "observed-entry";
  id: string;
  testCaseId: string;
  /** Carried from the start because Task 5's location join keys on the FULL four-part identity.
   *  Keying on `testCaseId` alone would join two entries that differ only by revision. */
  testCaseRevisionId: string;
  testCaseInstanceId: string;
  status: string;
  failureClassification: string;
  executionSurface: string;
  durationMs: number;
  /** The claim's own `record.provenance` (defaulted per `provenanceOf` below) — carried so a CI reader
   *  can tell a runtime-observed row from an `agent-draft` one. This is NOT a credit filter: see
   *  `provenanceOf`'s comment for why this reducer carries the fact instead of acting on it. */
  provenance: string;
  location?: ProjectionLocation;
}>;

export type FindingRow = Readonly<{ ruleId: string; level: "error" | "warning"; id: string; message: string }>;

export type ProjectionModel = Readonly<{
  runId: string;
  producerVersion: string;
  generatedAt: string;
  reduced: boolean;
  gate: Readonly<{ artifactId: string; sha256: string; recommendation: string; verdicts: readonly Readonly<{ rule: string; passed: boolean; reason: string }>[] }>;
  attempts: readonly AttemptRow[];
  findings: readonly FindingRow[];
  anchor?: Readonly<{ commitSha: string; specTreeSha256: string }>;
  sourceArtifacts: readonly Readonly<{ id: string; sha256: string; type: string }>[];
}>;

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const arr = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** Sum of MEASURED step durations, for both lanes. A lane-2 entry has no timestamps of its own — only
 *  the batch has them — so reading `startedAt`/`finishedAt` would make lane 1 and lane 2 report
 *  different things under one column. Step durations are what both lanes actually measured. */
function durationOf(value: Readonly<Record<string, unknown>>): number {
  return arr(value.steps).filter(isRecord).reduce((total, step) => total + (typeof step.durationMs === "number" ? step.durationMs : 0), 0);
}

/**
 * The claim's own provenance, defaulted to `"agent-draft"` when the record carries none —
 * `RunWorkspace.registerArtifactValue` stamps that exact default on an unstamped registration
 * (`src/core/provenance.ts`'s own comment says so), so an absent value here means the same thing it
 * means everywhere else in the artifact system: recorded, but not runtime-observed. A silent `undefined`
 * or an invented fourth label would let this one reducer claim a provenance the record itself does not
 * carry, which is the same defect one level down from the one this field exists to fix.
 *
 * This is deliberately NOT a credit filter. The coverage readers gate on
 * `creditsCoverage(record.provenance)` (`release-gate.ts:249,254`) because THEY decide what earns
 * credit; `generate-qa-report.ts:39-41` already settled that a report instead "describes what the run
 * recorded rather than what earned credit," and a projection is exactly such a report. Carrying
 * `provenance` on every row lets a CI consumer see the fact for itself — filtering or hiding an
 * `agent-draft` row here would silently apply the credit gate this file must not apply.
 */
function provenanceOf(record: Readonly<{ provenance?: string }>): string {
  return record.provenance ?? "agent-draft";
}

export function buildProjectionModel(input: Readonly<{
  runId: string; producerVersion: string; generatedAt: string; artifacts: readonly ProjectionArtifact[];
}>): ProjectionModel {
  const gateArtifact = input.artifacts.find((artifact) => artifact.record.type === "release-gate");
  if (!gateArtifact) throw new QaSkillsError("This run has no release gate: only a finalized run can be projected", "INVALID_ARTIFACT");

  const verdicts = arr(gateArtifact.value.verdicts).filter(isRecord).flatMap((verdict) => {
    const rule = str(verdict.rule);
    const reason = str(verdict.reason);
    return rule === undefined || reason === undefined || typeof verdict.passed !== "boolean" ? [] : [{ rule, passed: verdict.passed, reason }];
  });
  const sourceArtifacts = arr(gateArtifact.value.sourceArtifacts).filter(isRecord).flatMap((entry) => {
    const id = str(entry.id); const sha256 = str(entry.sha256); const type = str(entry.type);
    return id === undefined || sha256 === undefined || type === undefined ? [] : [{ id, sha256, type }];
  });

  // Lane 1's Execution Surface is structural, not declared: the runtime drives every `test-result`
  // through a live browser context, which is why `release-gate.ts:63-70` hardcodes "browser" for the
  // driven lane too. Reading a field the `test-result` schema does not have would invent a value.
  const driven: AttemptRow[] = input.artifacts.filter((artifact) => artifact.record.type === "test-result").flatMap((artifact) => {
    const id = str(artifact.value.attemptId); const testCaseId = str(artifact.value.testCaseId);
    const testCaseRevisionId = str(artifact.value.testCaseRevisionId);
    const testCaseInstanceId = str(artifact.value.testCaseInstanceId); const status = str(artifact.value.status);
    const failureClassification = str(artifact.value.failureClassification);
    return id === undefined || testCaseId === undefined || testCaseRevisionId === undefined || testCaseInstanceId === undefined || status === undefined || failureClassification === undefined
      ? []
      : [{ lane: "driven-attempt" as const, id, testCaseId, testCaseRevisionId, testCaseInstanceId, status, failureClassification, executionSurface: "browser", durationMs: durationOf(artifact.value), provenance: provenanceOf(artifact.record) }];
  });

  const batches = input.artifacts.filter((artifact) => artifact.record.type === "test-result-batch");
  // Every entry in one batch shares the manifest record's provenance: lane 2 has no per-entry
  // registration, only the one record the whole `test-result-batch` artifact was registered under.
  const observed: AttemptRow[] = batches.flatMap((artifact) => {
    const provenance = provenanceOf(artifact.record);
    return arr(artifact.value.entries).filter(isRecord).flatMap((entry) => {
      const id = str(entry.entryId); const testCaseId = str(entry.testCaseId);
      const testCaseRevisionId = str(entry.testCaseRevisionId);
      const testCaseInstanceId = str(entry.testCaseInstanceId); const status = str(entry.status);
      const failureClassification = str(entry.failureClassification); const executionSurface = str(entry.executionSurface);
      return id === undefined || testCaseId === undefined || testCaseRevisionId === undefined || testCaseInstanceId === undefined || status === undefined || failureClassification === undefined || executionSurface === undefined
        ? []
        : [{ lane: "observed-entry" as const, id, testCaseId, testCaseRevisionId, testCaseInstanceId, status, failureClassification, executionSurface, durationMs: durationOf(entry), provenance }];
    });
  });

  const anchorSource = batches[0]?.value;
  const commitSha = anchorSource === undefined ? undefined : str(anchorSource.commitSha);
  const specTreeSha256 = anchorSource === undefined ? undefined : str(anchorSource.specTreeSha256);

  return {
    runId: input.runId,
    producerVersion: input.producerVersion,
    generatedAt: input.generatedAt,
    reduced: gateArtifact.value.protectedEnvironment === true,
    gate: { artifactId: gateArtifact.record.id, sha256: gateArtifact.record.sha256, recommendation: str(gateArtifact.value.recommendation) ?? "NOT_READY", verdicts },
    attempts: [...driven, ...observed],
    findings: [],
    ...(commitSha === undefined || specTreeSha256 === undefined ? {} : { anchor: { commitSha, specTreeSha256 } }),
    sourceArtifacts,
  };
}
