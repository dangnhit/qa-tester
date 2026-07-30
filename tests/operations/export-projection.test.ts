import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
 * with the identity the matching batch entry reports. This payload is what the export operation must
 * read off disk: it is registered as a BINARY, so `readRegisteredArtifacts` never parses it into any
 * artifact's `.value` (`inspect-workspace-state.ts:324` returns early for any record with a mediaType).
 *
 * `config.rootDir` is part of the shape, not decoration: `sanitizeRunnerReport` keeps it (`configKeys`
 * at src/observed/sanitize-report.ts:64) and Playwright's reporter always emits it, absolute. It is
 * what `spec.file` is relative to — `execute-observed-playwright.ts:238` resolves the identical field
 * as `resolve(rootDir, file)` — so the export must rebase it before SARIF's `artifactLocation.uri`,
 * which GitHub code scanning reads relative to the REPOSITORY root, can mean what it says.
 *
 * These fixtures put `rootDir` at `<root>/e2e`, the ordinary `testDir: "./e2e"` case, so the joined URI
 * must come out as `e2e/<file>` rather than the runner's own `<file>`. The fixtures on this branch used
 * to carry no `config` at all, which is exactly why no test could see the difference.
 */
const reportTagging = (rootDir: string, testCaseId: string, file: string, line: number): string => JSON.stringify({
  sanitization: { policy: "qa-skills/observed-runner-report/v1", removed: [], note: "" },
  config: { version: "1.61.0", rootDir },
  suites: [{
    title: file,
    specs: [{ title: `[qa:${testCaseId}/REV-1/INSTANCE-1@api] pays with a card`, ok: false, id: `spec-${testCaseId}`, file, line, column: 3, tests: [] }],
  }],
}, null, 2);

/** One Runtime-Observed Execution to register: its own test case, its own `runner-report` evidence
 *  bundle, and the `test-result-batch` whose failing entry cites that bundle. A run may hold several
 *  (an external suite run per surface, say), which is why `finalizedRun` takes a list.
 *
 *  `report` is a FUNCTION of the run root because a sanitized report's `config.rootDir` is absolute,
 *  and the root is a fresh `mkdtemp` directory that does not exist when these fixtures are declared. */
type Observation = Readonly<{ suffix: string; testCaseId: string; evidenceId: string; report: (root: string) => string }>;

const observation = (over: Partial<Observation> = {}): Observation => ({
  suffix: "1", testCaseId: "TC-CHECKOUT", evidenceId: "01K0ABCDEFGHJKMNPQRSTVWXYZ",
  report: (root) => reportTagging(join(root, "e2e"), "TC-CHECKOUT", "checkout.spec.ts", 42), ...over,
});

async function registerObservation(workspace: RunWorkspace, entry: Observation, root: string): Promise<void> {
  const value = { ...testCase, testCaseId: entry.testCaseId };
  const registeredCase = await workspace.registerArtifactValue({ type: "test-case", value, relationships: [] });
  const executionId = `EXEC-${entry.suffix}`;
  const bundle = await workspace.registerEvidenceBundle({
    binaries: [{ filename: "sanitized-runner-report.json", contents: Buffer.from(entry.report(root), "utf8"), mediaType: "application/json", captureType: "runner-report" }],
    relationships: [],
    provenance: "runtime",
    descriptor: (binaries) => ({
      artifactType: "evidence", schemaVersion: "3.0.0", producerVersion: "0.1.0",
      evidenceId: entry.evidenceId, runId: workspace.runId,
      subject: { kind: "observed-execution", executionId },
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
      executionId, runId: workspace.runId, commitSha: "a".repeat(40), specTreeSha256: "b".repeat(64),
      startedAt: "2026-07-29T00:00:00.000Z", finishedAt: "2026-07-29T00:01:00.000Z",
      entries: [{ entryId: `E-${entry.suffix}`, testCaseId: entry.testCaseId, testCaseRevisionId: testCase.revisionId, testCaseInstanceId: testCase.instanceId, status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "api", steps: [{ stepId: "S1", status: "FAILED", durationMs: 500 }], evidenceArtifactIds: [bundle.descriptor.id] }],
    },
  });
}

/**
 * A finalized run carrying both lanes' shapes: one or more Runtime-Observed Executions, one operational
 * Evidence Gap — which is what drives the gate to NOT_READY through `NO_SHARED_BLOCKERS` — and the
 * release gate `generateQaReport` derives from all of it.
 *
 * The observations are parameterised so a case can register a second execution, or an unparseable
 * payload, through the very same registration path a real run uses.
 */
async function finalizedRun(observations: readonly Observation[] = [observation()]): Promise<{ root: string; runId: string }> {
  const root = await mkdtemp(join(tmpdir(), "qa-export-")); roots.push(root);
  const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
  for (const entry of observations) await registerObservation(workspace, entry, root);
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
    expect(observed?.locations).toEqual([{ physicalLocation: { artifactLocation: { uri: "e2e/checkout.spec.ts" }, region: { startLine: 42 } } }]);
  });

  // The reason is a FIXED string in both rows, and the assertions pin that: V8's SyntaxError text would
  // have quoted the payload back, and this string leaves the artifact system for a CI log.
  it.each([
    ["a payload that is not JSON at all", "{ password123 is not json", "payload is not valid JSON"],
    ["a payload that parses to something other than an object", "[]", "payload is not a JSON object"],
  ])("still writes the projection when a registered runner report is unreadable (%s), and names what it could not read", async (_label, payload, reason) => {
    const { root, runId } = await finalizedRun([observation({ report: () => payload })]);
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

  it("refuses a run that was never finalized, naming the missing gate, and leaves no empty outputs behind", async () => {
    const { root, runId } = await unfinalizedRun();

    await expect(exportProjection({ root, runId, format: "sarif", outPath: join(root, "x.sarif") }))
      .rejects.toThrow(/release gate/i);

    // Both outputs are opened before the run is read, so any refusal AFTER that point has empty files
    // of its own to take back. The residue policy is not specific to a containment refusal, and this is
    // the ordinary failure that proves it.
    expect(await readdir(root)).toEqual(["qa-results"]);
  });

  /**
   * The name promises an ORDERING, so the ordering is what is asserted: the run id names no run at all,
   * so if the format check did not come first, `RunWorkspace.open`'s `realpath` would answer ENOENT
   * instead. Getting the format message back is the proof that nothing was opened.
   */
  it("refuses an unsupported format before opening anything", async () => {
    const { root } = await finalizedRun();

    await expect(exportProjection({ root, runId: "RUN-DOES-NOT-EXIST", format: "tap", outPath: join(root, "x.tap") }))
      .rejects.toThrow(/junit or sarif/i);
  });

  /**
   * A run may register more than one Runtime-Observed Execution — an external suite run per surface, or
   * a second suite entirely — and each carries its own sanitized report. The loop over sources was only
   * ever exercised with zero or one before this test, so nothing proved a SECOND report was read at all
   * rather than the first one winning.
   */
  it("reads every registered runner report, not just the first, when a run holds two observed executions", async () => {
    const { root, runId } = await finalizedRun([
      observation(),
      observation({ suffix: "2", testCaseId: "TC-SEARCH", evidenceId: "01K0ABCDEFGHJKMNPQRSTVWXY2", report: (root) => reportTagging(join(root, "e2e"), "TC-SEARCH", "search.spec.ts", 7) }),
    ]);
    const outPath = join(root, "two.sarif");

    await exportProjection({ root, runId, format: "sarif", outPath });

    const sarif = JSON.parse(await readFile(outPath, "utf8")) as { runs: [{ results: { ruleId: string; locations?: { physicalLocation: { artifactLocation: { uri: string } } }[] }[] }] };
    const located = sarif.runs[0].results.filter((entry) => entry.ruleId === "observed-failure")
      .flatMap((entry) => entry.locations ?? []).map((location) => location.physicalLocation.artifactLocation.uri);
    expect(located.sort()).toEqual(["e2e/checkout.spec.ts", "e2e/search.spec.ts"]);
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

  /**
   * `O_TRUNC` is deliberately withheld at open — it would empty the file before anything could refuse
   * the write — so the truncation has to be performed explicitly at write time instead. Nothing else in
   * this file would notice if it went missing: every other case writes to a path with no bytes at it.
   * Hashing the file on disk against the checksum the operation REPORTS is the exact assertion, because
   * a trailing tail of the previous export makes those two disagree.
   */
  it("overwrites an existing --out completely, leaving no bytes of a longer previous export behind", async () => {
    const { root, runId } = await finalizedRun();
    const outPath = join(root, "qa-junit.xml");
    await writeFile(outPath, "X".repeat(50_000), "utf8");

    const result = await exportProjection({ root, runId, format: "junit", outPath });

    const bytes = await readFile(outPath);
    expect(bytes.toString("utf8")).not.toContain("XXX");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(result.projectionSha256);
  });

  /**
   * The mirror of "leaves no sidecar behind when the projection itself cannot be written": here the
   * PROJECTION opens fine — creating an empty file — and the sidecar's open is the one that fails. Both
   * outputs or neither, at the open step too, or an unwritable sidecar would leave a bare empty file
   * where an operator's CI will look for a projection.
   */
  it("removes the projection file it had just created when the sidecar cannot even be opened", async () => {
    const { root, runId } = await finalizedRun();
    const outPath = join(root, "unopenable.xml");
    await mkdir(`${outPath}.provenance.json`);

    await expect(exportProjection({ root, runId, format: "junit", outPath })).rejects.toThrow();

    await expect(readFile(outPath, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("refuses an --out that would land inside the finalized run it is reading", async () => {
    const { root, runId } = await finalizedRun();

    await expect(exportProjection({ root, runId, format: "junit", outPath: join(root, "qa-results", runId, "inputs", "sneak.xml") }))
      .rejects.toThrow(/inside .*qa-results/i);
    expect(await readdir(join(root, "qa-results", runId, "inputs"))).not.toContain("sneak.xml");
  });

  /**
   * The guard covers the whole results root, not just the run being exported. A projection landing in
   * ANOTHER run's `inputs/` raises `ORPHAN_FILE` for THAT run on every later read
   * (`inspect-workspace-state.ts:542`) — it would brick a run this export never even opened, which is
   * strictly worse than bricking the one it did.
   */
  it("refuses an --out inside a different run's workspace, not just the one being exported", async () => {
    const { root, runId } = await finalizedRun();
    const other = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
    const otherRunId = other.runId;
    await other.close();

    await expect(exportProjection({ root, runId, format: "junit", outPath: join(root, "qa-results", otherRunId, "inputs", "sneak.xml") }))
      .rejects.toThrow(/inside .*qa-results/i);
    expect(await readdir(join(root, "qa-results", otherRunId, "inputs"))).not.toContain("sneak.xml");
  });

  /**
   * A symlink AT THE LEAF, pointing at a REGISTERED artifact file. `--out` names a path outside the
   * results root whose own inode is a symlink into a closed run, so a guard that resolved only the
   * output's PARENT directory would see an innocent temp directory and write straight through the link
   * — overwriting a checksummed artifact and leaving the run permanently CHECKSUM_MISMATCH.
   * `isRealPathWithin` resolves the candidate itself first (`nearestExistingParent` lstats it before
   * walking up), which is the whole reason the guard delegates to `core/fs.ts` rather than calling
   * `realpath(dirname(...))` here.
   */
  it("refuses an --out that is a symlink onto a registered artifact, not just one syntactically inside", async () => {
    const { root, runId } = await finalizedRun();
    const inputs = join(root, "qa-results", runId, "inputs");
    const registered = (await readdir(inputs))[0]!;
    const before = await readFile(join(inputs, registered), "utf8");
    const outside = await mkdtemp(join(tmpdir(), "qa-export-link-")); roots.push(outside);
    const outPath = join(outside, "junit.xml");
    await symlink(join(inputs, registered), outPath);

    await expect(exportProjection({ root, runId, format: "junit", outPath })).rejects.toThrow(/inside .*qa-results/i);
    expect(await readFile(join(inputs, registered), "utf8")).toBe(before);
  });

  /**
   * The same attack with a symlink whose target does not exist yet — `writeFile` would CREATE it inside
   * the run, leaving it ORPHAN_FILE. `isRealPathWithin` cannot resolve a dangling link, so it throws
   * rather than answering; the guard turns every such failure into a refusal, because its job is to
   * PROVE the write lands outside the runs and "I could not work out where this goes" is not a proof.
   */
  it("refuses a dangling symlink into a run workspace, creating nothing", async () => {
    const { root, runId } = await finalizedRun();
    const inputs = join(root, "qa-results", runId, "inputs");
    const outside = await mkdtemp(join(tmpdir(), "qa-export-dangling-")); roots.push(outside);
    const outPath = join(outside, "junit.xml");
    await symlink(join(inputs, "through-a-link.xml"), outPath);

    await expect(exportProjection({ root, runId, format: "junit", outPath })).rejects.toThrow(/destination could not be resolved/i);
    expect(await readdir(inputs)).not.toContain("through-a-link.xml");
  });

  /**
   * A symlink LOOP is the other way a destination cannot be resolved: `lstat` sees the link, `realpath`
   * answers ELOOP. It takes the same refusal as a dangling link — the guard does not care WHY it could
   * not answer, only that it could not.
   */
  it("refuses an --out whose symlinks form a loop", async () => {
    const { root, runId } = await finalizedRun();
    const outside = await mkdtemp(join(tmpdir(), "qa-export-loop-")); roots.push(outside);
    const first = join(outside, "first.xml");
    const second = join(outside, "second.xml");
    await symlink(second, first);
    await symlink(first, second);

    await expect(exportProjection({ root, runId, format: "junit", outPath: first }))
      .rejects.toThrow(/destination could not be resolved/i);
  });

  /**
   * THE SIDECAR PATH IS DERIVED, so a guard on `--out` alone never sees it — and being derived makes it
   * the easier of the two to attack: it needs no influence over the caller's argument at all. Here
   * `--out` is an ordinary unremarkable path that passes the guard, while `<out>.provenance.json` is a
   * symlink onto a REGISTERED artifact of a DIFFERENT run. Unguarded, `writeFile` follows it and that
   * other run is CHECKSUM_MISMATCH forever, while this command exits 0.
   */
  it("refuses when the derived sidecar path is a symlink onto another run's registered artifact", async () => {
    const { root, runId } = await finalizedRun();
    const other = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
    const otherRunId = other.runId;
    await other.close();
    const otherInputs = join(root, "qa-results", otherRunId, "inputs");
    const registered = (await readdir(otherInputs))[0]!;
    const before = await readFile(join(otherInputs, registered), "utf8");
    const outside = await mkdtemp(join(tmpdir(), "qa-export-sidecar-")); roots.push(outside);
    const outPath = join(outside, "junit.xml");
    await symlink(join(otherInputs, registered), `${outPath}.provenance.json`);

    await expect(exportProjection({ root, runId, format: "junit", outPath })).rejects.toThrow(/inside .*qa-results/i);

    expect(await readFile(join(otherInputs, registered), "utf8")).toBe(before);
    // Both outputs are checked BEFORE either is written, so the refusal leaves no projection behind
    // either — a projection with no sidecar is the state the sidecar exists to make impossible.
    await expect(readFile(outPath, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("refuses when the derived sidecar path is a dangling symlink into a run workspace", async () => {
    const { root, runId } = await finalizedRun();
    const inputs = join(root, "qa-results", runId, "inputs");
    const outside = await mkdtemp(join(tmpdir(), "qa-export-sidecar-dangling-")); roots.push(outside);
    const outPath = join(outside, "junit.xml");
    await symlink(join(inputs, "sidecar-through-a-link.json"), `${outPath}.provenance.json`);

    await expect(exportProjection({ root, runId, format: "junit", outPath })).rejects.toThrow(/destination could not be resolved/i);

    expect(await readdir(inputs)).not.toContain("sidecar-through-a-link.json");
    await expect(readFile(outPath, "utf8")).rejects.toThrow(/ENOENT/);
  });

  /**
   * A HARD LINK at `--out`, onto a REGISTERED artifact. No path check can see this one: `realpath` has
   * nothing to resolve for a second name, so it answers with the path it was handed, and every
   * path-shaped guard — this operation's included — correctly concludes the destination lies OUTSIDE the
   * results root. The bytes at that destination are nonetheless a checksummed artifact's, and a write
   * lands on the inode, not on the name. Only a question asked of the DESCRIPTOR sees it.
   *
   * The assertion that matters is the victim's bytes, not the rejection: a guard that rejected for some
   * unrelated reason while the overwrite still happened would pass a rejection-only test, which is
   * exactly how Phase 8a's round-1 symlink guard shipped with its bypass live.
   */
  it("refuses an --out that is a hard link onto a registered artifact, leaving that artifact's bytes intact", async () => {
    const { root, runId } = await finalizedRun();
    const inputs = join(root, "qa-results", runId, "inputs");
    const registered = (await readdir(inputs))[0]!;
    const before = await readFile(join(inputs, registered), "utf8");
    const outside = await mkdtemp(join(tmpdir(), "qa-export-hardlink-")); roots.push(outside);
    const outPath = join(outside, "junit.xml");
    await link(join(inputs, registered), outPath);

    await expect(exportProjection({ root, runId, format: "junit", outPath })).rejects.toThrow(/second name|hard link/i);

    expect(await readFile(join(inputs, registered), "utf8")).toBe(before);
    // Both descriptors are proven before either is written, so the refused projection leaves no sidecar.
    await expect(readFile(`${outPath}.provenance.json`, "utf8")).rejects.toThrow(/ENOENT/);
  });

  /**
   * The same attack through the DERIVED path, which needs no influence over the caller's argument at
   * all, and against a run this export never opened. The projection is proven at the same moment as the
   * sidecar, so refusing the sidecar must also mean no projection on disk — a projection nothing vouches
   * for is the state the sidecar exists to make impossible.
   */
  it("refuses when the derived sidecar path is a hard link onto another run's registered artifact, and writes no projection either", async () => {
    const { root, runId } = await finalizedRun();
    const other = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
    const otherRunId = other.runId;
    await other.close();
    const otherInputs = join(root, "qa-results", otherRunId, "inputs");
    const registered = (await readdir(otherInputs))[0]!;
    const before = await readFile(join(otherInputs, registered), "utf8");
    const outside = await mkdtemp(join(tmpdir(), "qa-export-sidecar-hardlink-")); roots.push(outside);
    const outPath = join(outside, "junit.xml");
    await link(join(otherInputs, registered), `${outPath}.provenance.json`);

    await expect(exportProjection({ root, runId, format: "junit", outPath })).rejects.toThrow(/second name|hard link/i);

    expect(await readFile(join(otherInputs, registered), "utf8")).toBe(before);
    await expect(readFile(outPath, "utf8")).rejects.toThrow(/ENOENT/);
  });

  /**
   * THE RESIDUE POLICY, both halves at once. `O_TRUNC` would empty the projection at OPEN time — before
   * any `fstat` could refuse the sidecar — so the operation must not use it: an existing `--out` keeps
   * its bytes through a refusal. And the file this operation CREATED (the sidecar's, here already taken)
   * is not the one it may delete: unlinking an operator's pre-existing file because a different output
   * was refused would make the guard destructive in its own right.
   */
  it("neither empties nor deletes an existing --out when the sidecar is refused", async () => {
    const { root, runId } = await finalizedRun();
    const inputs = join(root, "qa-results", runId, "inputs");
    const registered = (await readdir(inputs))[0]!;
    const before = await readFile(join(inputs, registered), "utf8");
    const outside = await mkdtemp(join(tmpdir(), "qa-export-residue-")); roots.push(outside);
    const outPath = join(outside, "junit.xml");
    await writeFile(outPath, "PREVIOUS EXPORT", "utf8");
    await link(join(inputs, registered), `${outPath}.provenance.json`);

    await expect(exportProjection({ root, runId, format: "junit", outPath })).rejects.toThrow(/second name|hard link/i);

    expect(await readFile(outPath, "utf8")).toBe("PREVIOUS EXPORT");
    expect(await readFile(join(inputs, registered), "utf8")).toBe(before);
  });

  /**
   * The operation writes only through a path it opened ITSELF. A symlink at `--out` whose target lies
   * outside the results root passes the path guard — legitimately, the write would land outside — and
   * `writeFile` used to follow it. `O_NOFOLLOW` refuses it instead, and the cost is real and deliberate:
   * an operator whose `--out` is a symlink to a file elsewhere now gets a refusal. That cost buys the
   * property the hard-link check depends on — the descriptor proven is the descriptor written, with no
   * name resolved twice.
   *
   * Gated: MEASURED, `fs.constants.O_NOFOLLOW` is 256 on darwin and absent on Windows, so this
   * refusal cannot exist there. (`tests/operations` is not in the Windows CI job today either.)
   */
  it.runIf(process.platform !== "win32")("refuses a symlinked --out rather than writing through it, even when the link target is outside the runs", async () => {
    const { root, runId } = await finalizedRun();
    const outside = await mkdtemp(join(tmpdir(), "qa-export-nofollow-")); roots.push(outside);
    const target = join(outside, "target.xml");
    await writeFile(target, "ORIGINAL", "utf8");
    const outPath = join(outside, "junit.xml");
    await symlink(target, outPath);

    await expect(exportProjection({ root, runId, format: "junit", outPath })).rejects.toThrow(/symbolic link/i);

    expect(await readFile(target, "utf8")).toBe("ORIGINAL");
  });

  /**
   * THE WINDOW between the guard and the writes, which Phase 8a widened by correctly moving the guard to
   * the first statement of the operation — ahead of `readRegisteredArtifacts` and every runner-report
   * read. `readRegisteredArtifacts` is used here as a CLOCK, not as a mock: it is the first thing the
   * operation does after the guard, so planting the symlink from inside it plants it squarely in the
   * window, and the real implementation still runs.
   *
   * The export SUCCEEDS here, and that is the correct outcome rather than a missed refusal: the bytes go
   * to the descriptor opened before the guard's answer could go stale, which by then is an unlinked
   * inode. Someone else moved the name; nothing followed them. The victim's bytes are the assertion.
   */
  it.runIf(process.platform !== "win32")("does not follow a symlink planted at --out after the path guard has already passed it", async () => {
    const { root, runId } = await finalizedRun();
    const inputs = join(root, "qa-results", runId, "inputs");
    const registered = (await readdir(inputs))[0]!;
    const before = await readFile(join(inputs, registered), "utf8");
    const outside = await mkdtemp(join(tmpdir(), "qa-export-window-")); roots.push(outside);
    const outPath = join(outside, "junit.xml");

    const attacker = vi.spyOn(RunWorkspace.prototype, "readRegisteredArtifacts")
      .mockImplementation(async function (this: RunWorkspace) {
        await rm(outPath, { force: true });
        await symlink(join(inputs, registered), outPath);
        // Restored from inside, so the call below is the real read: the spy is a clock, not a stub.
        attacker.mockRestore();
        return this.readRegisteredArtifacts();
      });
    try {
      await exportProjection({ root, runId, format: "junit", outPath });
    } finally {
      attacker.mockRestore();
    }

    expect(await readFile(join(inputs, registered), "utf8")).toBe(before);
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
