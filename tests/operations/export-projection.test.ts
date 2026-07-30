import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RunWorkspace } from "../../src/core/run-workspace.js";
import { runtimeVersion } from "../../src/installer/manifest.js";
import { exportProjection, runnerReportSources } from "../../src/operations/export-projection.js";
import { generateQaReport } from "../../src/operations/generate-qa-report.js";
import type { ProjectionArtifact } from "../../src/reporting/projections/projection-model.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const environment = { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "ENV-EXPORT", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false } as const;
const testCase = { artifactType: "test-case", schemaVersion: "2.0.0", producerVersion: "0.1.0", testCaseId: "TC-CHECKOUT", revisionId: "REV-1", instanceId: "INSTANCE-1", title: "Checkout saves an order", steps: [{ id: "open", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ-CHECKOUT", role: "buyer", behavior: "checkout", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "high", outcome: "Order confirmation is shown" } } as const;

/**
 * The bytes lane 2 actually registers as the sanitized runner report — shaped exactly as
 * `sanitizeRunnerReport` writes them (src/observed/sanitize-report.ts:124-134), with one spec tagged
 * with the identity `observedEntry` below reports. This payload is what the export operation must read
 * off disk: it is registered as a BINARY, so `readRegisteredArtifacts` never parses it into any
 * artifact's `.value` (`inspect-workspace-state.ts:324` returns early for any record with a mediaType).
 */
const sanitizedReport = JSON.stringify({
  sanitization: { policy: "qa-skills/observed-runner-report/v1", removed: [], note: "" },
  suites: [{
    title: "checkout.spec.ts",
    specs: [{ title: "[qa:TC-CHECKOUT/REV-1/INSTANCE-1@api] pays with a card", ok: false, id: "spec-1", file: "specs/checkout.spec.ts", line: 42, column: 3, tests: [] }],
  }],
}, null, 2);

/**
 * A finalized run carrying both lanes' shapes: one registered test case, one Runtime-Observed Execution
 * (a `runner-report` evidence bundle plus the `test-result-batch` whose failing entry cites it), one
 * operational Evidence Gap — which is what drives the gate to NOT_READY through `NO_SHARED_BLOCKERS` —
 * and the release gate `generateQaReport` derives from all of it.
 *
 * `report` is the sanitized report's bytes, parameterised only so the malformed-payload cases can
 * register something unparseable through the very same registration path a real run uses.
 */
async function finalizedRun(report: string = sanitizedReport): Promise<{ root: string; runId: string }> {
  const root = await mkdtemp(join(tmpdir(), "qa-export-")); roots.push(root);
  const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
  const registeredCase = await workspace.registerArtifactValue({ type: "test-case", value: testCase, relationships: [] });
  const bundle = await workspace.registerEvidenceBundle({
    binaries: [{ filename: "sanitized-runner-report.json", contents: Buffer.from(report, "utf8"), mediaType: "application/json", captureType: "runner-report" }],
    relationships: [],
    provenance: "runtime",
    descriptor: (binaries) => ({
      artifactType: "evidence", schemaVersion: "3.0.0", producerVersion: "0.1.0",
      evidenceId: "01K0ABCDEFGHJKMNPQRSTVWXYZ", runId: workspace.runId,
      subject: { kind: "observed-execution", executionId: "EXEC-1" },
      kind: "runner-report", capturedAt: "2026-07-29T00:01:00.000Z",
      sha256: binaries[0]!.sha256, relativePath: binaries[0]!.relativePath, mediaType: "application/json",
      binaryArtifactIds: binaries.map((binary) => binary.id),
      binaryArtifacts: binaries.map((binary) => ({ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType })),
      provenance: { captureType: "runner-report", runner: "playwright", runnerVersion: "1.61.0", exitCode: 1, capturedAt: "2026-07-29T00:01:00.000Z" },
    }),
  });
  await workspace.registerArtifactValue({
    type: "test-result-batch", provenance: "runtime-observed", relationships: [registeredCase.id, bundle.descriptor.id],
    value: {
      artifactType: "test-result-batch", schemaVersion: "3.0.0", producerVersion: "0.1.0",
      executionId: "EXEC-1", runId: workspace.runId, commitSha: "a".repeat(40), specTreeSha256: "b".repeat(64),
      startedAt: "2026-07-29T00:00:00.000Z", finishedAt: "2026-07-29T00:01:00.000Z",
      entries: [{ entryId: "E-1", testCaseId: testCase.testCaseId, testCaseRevisionId: testCase.revisionId, testCaseInstanceId: testCase.instanceId, status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "api", steps: [{ stepId: "S1", status: "FAILED", durationMs: 500 }], evidenceArtifactIds: [bundle.descriptor.id] }],
    },
  });
  await workspace.registerArtifactValue({
    type: "evidence-gap", relationships: [],
    value: { artifactType: "evidence-gap", schemaVersion: "1.0.0", producerVersion: "0.1.0", evidenceGapId: "GAP-1", runId: workspace.runId, scope: "operational", reason: "Trace retention refused by the environment profile", affectedClaim: "the checkout total shown to a signed-in buyer" },
  });
  await generateQaReport({ workspace });
  await workspace.finalize("execute");
  await workspace.close();
  return { root, runId: workspace.runId };
}

/** A run with no release gate at all: the shape `exportProjection` must refuse. */
async function unfinalizedRun(): Promise<{ root: string; runId: string }> {
  const root = await mkdtemp(join(tmpdir(), "qa-export-open-")); roots.push(root);
  const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
  await workspace.registerArtifactValue({ type: "test-case", value: testCase, relationships: [] });
  const runId = workspace.runId;
  await workspace.close();
  return { root, runId };
}

describe("exportProjection", () => {
  it("writes the projection and a sidecar whose checksum matches the bytes on disk", async () => {
    const { root, runId } = await finalizedRun();
    const outPath = join(root, "qa-junit.xml");

    const result = await exportProjection({ root, runId, format: "junit", outPath });

    const bytes = await readFile(result.outPath);
    const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf8")) as Record<string, unknown>;
    expect(sidecar.projectionSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.projectionSha256).toBe(sidecar.projectionSha256);
    expect(sidecar).toMatchObject({ projection: "junit", runId, gate: { recommendation: "NOT_READY" }, reduced: false });
    expect(sidecar.producerVersion).toBe(runtimeVersion);
    // The sidecar binds the bytes to the SOURCE artifacts too, not just the gate: without them a reader
    // can prove which gate the file projects but not what that gate was computed from.
    expect(Array.isArray(sidecar.sourceArtifacts) && (sidecar.sourceArtifacts as unknown[]).length > 0).toBe(true);
    expect(bytes.toString("utf8")).toContain("<testsuites");
  });

  it("exports SARIF from the same run, and reports the gate's own recommendation without re-deriving it", async () => {
    const { root, runId } = await finalizedRun();
    const outPath = join(root, "qa.sarif");

    const result = await exportProjection({ root, runId, format: "sarif", outPath });

    expect(result).toMatchObject({ format: "sarif", outPath, sidecarPath: `${outPath}.provenance.json`, recommendation: "NOT_READY", reduced: false, unreadableRunnerReports: [] });
    const sarif = JSON.parse(await readFile(outPath, "utf8")) as { runs: [{ results: { ruleId: string }[] }] };
    expect(sarif.runs[0].results.map((entry) => entry.ruleId)).toContain("evidence-gap");
  });

  /**
   * The payload wiring, end to end. `specLocationsByEntryIdentity` can only join a spec location if it
   * is handed the sanitized report, and the sanitized report is a registered BINARY — so this passes
   * only when the operation reads the file at the descriptor's `relativePath` and parses it. With the
   * read omitted, the SARIF result for the failing observed entry carries no `locations` at all.
   */
  it("joins the spec location out of the registered sanitized report, which no artifact value carries", async () => {
    const { root, runId } = await finalizedRun();
    const outPath = join(root, "located.sarif");

    await exportProjection({ root, runId, format: "sarif", outPath });

    const sarif = JSON.parse(await readFile(outPath, "utf8")) as { runs: [{ results: { ruleId: string; locations?: { physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } } }[] }[] }] };
    const observed = sarif.runs[0].results.find((entry) => entry.ruleId === "observed-failure");
    expect(observed?.locations).toEqual([{ physicalLocation: { artifactLocation: { uri: "specs/checkout.spec.ts" }, region: { startLine: 42 } } }]);
  });

  // The reason is a FIXED string in both rows, and the assertions pin that: V8's SyntaxError text would
  // have quoted the payload back, and this string leaves the artifact system for a CI log.
  it.each([
    ["a payload that is not JSON at all", "{ password123 is not json", "payload is not valid JSON"],
    ["a payload that parses to something other than an object", "[]", "payload is not a JSON object"],
  ])("still writes the projection when a registered runner report is unreadable (%s), and names what it could not read", async (_label, payload, reason) => {
    const { root, runId } = await finalizedRun(payload);
    const outPath = join(root, "degraded.sarif");

    const result = await exportProjection({ root, runId, format: "sarif", outPath });

    // Degraded, never absent: the projection is written and the gate is still projected in full; only
    // the location annotation the unreadable payload would have carried is missing.
    expect(result.unreadableRunnerReports).toHaveLength(1);
    expect(result.unreadableRunnerReports[0]?.relativePath).toMatch(/^evidence\//);
    expect(result.unreadableRunnerReports[0]?.reason).toBe(reason);
    expect(JSON.stringify(result.unreadableRunnerReports)).not.toContain("password123");
    const sarif = JSON.parse(await readFile(outPath, "utf8")) as { runs: [{ results: { ruleId: string; locations?: unknown }[] }] };
    expect(sarif.runs[0].results.find((entry) => entry.ruleId === "observed-failure")?.locations).toBeUndefined();
    expect(sarif.runs[0].results.map((entry) => entry.ruleId)).toContain("evidence-gap");
  });

  it("refuses a run that was never finalized, naming the missing gate", async () => {
    const { root, runId } = await unfinalizedRun();

    await expect(exportProjection({ root, runId, format: "sarif", outPath: join(root, "x.sarif") }))
      .rejects.toThrow(/release gate/i);
  });

  it("refuses an unsupported format before opening anything", async () => {
    const { root, runId } = await finalizedRun();

    await expect(exportProjection({ root, runId, format: "tap", outPath: join(root, "x.tap") }))
      .rejects.toThrow(/junit or sarif/i);
  });

  it("writes nothing inside the run workspace", async () => {
    const { root, runId } = await finalizedRun();
    const runPath = join(root, "qa-results", runId);
    const before = await readdir(runPath, { recursive: true });

    await exportProjection({ root, runId, format: "sarif", outPath: join(root, "qa.sarif") });

    expect((await readdir(runPath, { recursive: true })).sort()).toEqual(before.sort());
  });

  /**
   * The write ORDER, which is otherwise invisible: the projection is written first so a sidecar never
   * describes bytes that do not exist. An existing directory at `--out` is what makes the order
   * observable — the first write fails with EISDIR, and whichever file was written before it survives.
   * Written second, the sidecar is never created; written first, it would be left behind making a
   * provenance claim about a file that was never produced.
   */
  it("leaves no sidecar behind when the projection itself cannot be written", async () => {
    const { root, runId } = await finalizedRun();
    const outPath = join(root, "occupied.xml");
    await mkdir(outPath);

    await expect(exportProjection({ root, runId, format: "junit", outPath })).rejects.toThrow();

    await expect(readFile(`${outPath}.provenance.json`, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("refuses an --out that would land inside the finalized run it is reading", async () => {
    const { root, runId } = await finalizedRun();

    await expect(exportProjection({ root, runId, format: "junit", outPath: join(root, "qa-results", runId, "inputs", "sneak.xml") }))
      .rejects.toThrow(/inside the run workspace/i);
    expect(await readdir(join(root, "qa-results", runId, "inputs"))).not.toContain("sneak.xml");
  });
});

const evidenceDescriptor = (overrides: Readonly<Record<string, unknown>> = {}): ProjectionArtifact => ({
  record: { id: "evidence-1", sha256: "f".repeat(64), type: "evidence", provenance: "runtime" },
  value: {
    artifactType: "evidence", schemaVersion: "3.0.0", evidenceId: "EV-1", runId: "RUN-1",
    subject: { kind: "observed-execution", executionId: "EXEC-1" }, kind: "runner-report",
    relativePath: "evidence/1-sanitized-runner-report.json", mediaType: "application/json",
    ...overrides,
  },
});

describe("runnerReportSources", () => {
  it("names the file behind every registered runner-report evidence descriptor", () => {
    expect(runnerReportSources([evidenceDescriptor()])).toEqual([{ artifactId: "evidence-1", relativePath: "evidence/1-sanitized-runner-report.json" }]);
  });

  it("ignores an evidence descriptor of any other kind, so a screenshot is never parsed as a report", () => {
    expect(runnerReportSources([evidenceDescriptor({ kind: "screenshot", mediaType: "image/png" })])).toEqual([]);
  });

  // Inherited from Task 5's `specLocationsByEntryIdentity`, which used to apply this filter itself. The
  // filter did not go away when the payloads moved to the impure edge -- it moved here with them, and is
  // strictly narrower now: type `evidence` AND kind `runner-report`, not type `evidence` alone.
  it("ignores a non-evidence artifact even when its value is shaped exactly like a runner-report descriptor", () => {
    const disguised: ProjectionArtifact = { ...evidenceDescriptor(), record: { id: "gate-1", sha256: "a".repeat(64), type: "release-gate" } };
    expect(runnerReportSources([disguised])).toEqual([]);
  });

  it("ignores a descriptor whose relativePath is not a string, rather than reading a path it invented", () => {
    expect(runnerReportSources([evidenceDescriptor({ relativePath: 42 })])).toEqual([]);
  });
});
