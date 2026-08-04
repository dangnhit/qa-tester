import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { generateQaReport } from "../../src/operations/generate-qa-report.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const environment = { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "0.1.0", environmentProfileId: "ENV-EXPORT-CLI", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false } as const;
const testCase = { artifactType: "test-case", schemaVersion: "3.0.0", producerVersion: "0.1.0", testCaseId: "TC-CHECKOUT", revisionId: "REV-1", instanceId: "INSTANCE-1", title: "Checkout saves an order", steps: [{ id: "open", action: "navigate", sideEffect: "none" }], coverage: { requirementId: "REQ-CHECKOUT", role: "buyer", behavior: "checkout", browser: "chromium", viewport: { width: 1280, height: 720 }, accessibilityMethod: null, risk: "high", outcome: "Order confirmation is shown" } } as const;

/**
 * A sanitized runner report naming a spec per identity, shaped as `sanitizeRunnerReport` writes one.
 *
 * `rootDir` is what `spec.file` is relative to, and passing it is what decides whether the export can
 * place the result at all: an absolute path the run root CONTAINS joins a location, and omitting it
 * entirely joins none — which is the difference between the placed and unplaced rows below.
 */
const sanitizedReport = (rootDir: string | undefined, specs: readonly Readonly<{ testCaseId: string; file: string }>[]): string => JSON.stringify({
  sanitization: { policy: "p", removed: [], note: "" },
  ...(rootDir === undefined ? {} : { config: { version: "1.61.0", rootDir } }),
  suites: [{ title: "s", specs: specs.map((spec) => ({ title: `[qa:${spec.testCaseId}/REV-1/INSTANCE-1@api] pays with a card`, ok: false, id: `spec-${spec.testCaseId}`, file: spec.file, line: 42, column: 3, tests: [] })) }],
});

/**
 * A finalized run whose gate is NOT_READY. The operational Evidence Gap is what makes it so: it becomes
 * a shared blocker, and `NO_SHARED_BLOCKERS` is a hard failure. The `runner-report` evidence bundle is
 * registered because the export operation reads the file behind it — `report` is parameterised only so
 * the unreadable-payload case can register something unparseable through the real registration path, and
 * takes the run root because a sanitized report's `config.rootDir` is absolute and the root is a fresh
 * `mkdtemp` directory that does not exist when a case is declared.
 *
 * `observedFailures` names one test case per FAILED `test-result-batch` entry, and registers each case:
 * that batch is the only shape that produces a SARIF `observed-failure` result at all, and an entry must
 * resolve to a registered case. Which of those results the export can PLACE is decided entirely by the
 * report — so passing two identities and a report naming only one is how a PARTIAL count is reached.
 *
 * Redeclared here rather than imported from `tests/operations/export-projection.test.ts`: fixtures are
 * not shared across test files on this branch.
 */
async function notReadyRun(
  report: string | ((root: string) => string) = sanitizedReport(undefined, []),
  observedFailures: readonly string[] = [],
): Promise<{ root: string; runId: string }> {
  const root = await mkdtemp(join(tmpdir(), "qa-export-cli-")); roots.push(root);
  const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
  const bundle = await workspace.registerEvidenceBundle({
    binaries: [{ filename: "sanitized-runner-report.json", contents: Buffer.from(typeof report === "string" ? report : report(root), "utf8"), mediaType: "application/json", captureType: "runner-report" }],
    relationships: [],
    provenance: "runtime",
    descriptor: (binaries) => ({
      artifactType: "evidence", schemaVersion: "4.0.0", producerVersion: "0.1.0",
      evidenceId: "01K0ABCDEFGHJKMNPQRSTVWXYZ", runId: workspace.runId,
      subject: { kind: "observed-execution", executionId: "EXEC-1" },
      kind: "runner-report", capturedAt: "2026-07-29T00:01:00.000Z",
      sha256: binaries[0]!.sha256, relativePath: binaries[0]!.relativePath, mediaType: "application/json",
      binaryArtifactIds: binaries.map((binary) => binary.id),
      binaryArtifacts: binaries.map((binary) => ({ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType })),
      provenance: { captureType: "runner-report", runner: "playwright", runnerVersion: "1.61.0", exitCode: 1, capturedAt: "2026-07-29T00:01:00.000Z" },
    }),
  });
  if (observedFailures.length > 0) {
    const registeredCases = await Promise.all(observedFailures.map((testCaseId) =>
      workspace.registerArtifactValue({ type: "test-case", value: { ...testCase, testCaseId }, relationships: [] })));
    await workspace.registerArtifactValue({
      type: "test-result-batch", provenance: "runtime-observed", relationships: [...registeredCases.map((registered) => registered.id), bundle.descriptor.id],
      value: {
        artifactType: "test-result-batch", schemaVersion: "4.0.0", producerVersion: "0.1.0",
        executionId: "EXEC-1", runId: workspace.runId, commitSha: "a".repeat(40), specTreeSha256: "b".repeat(64),
        startedAt: "2026-07-29T00:00:00.000Z", finishedAt: "2026-07-29T00:01:00.000Z",
        entries: observedFailures.map((testCaseId, index) => ({ entryId: `E-${index + 1}`, testCaseId, testCaseRevisionId: testCase.revisionId, testCaseInstanceId: testCase.instanceId, status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "api", steps: [{ stepId: "S1", status: "FAILED", durationMs: 500 }], evidenceArtifactIds: [bundle.descriptor.id] })),
      },
    });
  }
  await workspace.registerArtifactValue({
    type: "evidence-gap", relationships: [],
    value: { artifactType: "evidence-gap", schemaVersion: "3.0.0", producerVersion: "0.1.0", evidenceGapId: "GAP-1", runId: workspace.runId, scope: "operational", reason: "Trace retention refused by the environment profile", affectedClaim: "the checkout total shown to a signed-in buyer" },
  });
  await generateQaReport({ workspace });
  await workspace.finalize("execute");
  const runId = workspace.runId;
  await workspace.close();
  return { root, runId };
}

/** A run with no release gate: `export` has nothing to project and must refuse. */
async function runWithoutGate(): Promise<{ root: string; runId: string }> {
  const root = await mkdtemp(join(tmpdir(), "qa-export-cli-open-")); roots.push(root);
  const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
  const runId = workspace.runId;
  await workspace.close();
  return { root, runId };
}

describe("qa-skill export", () => {
  it("exits 0 with the projection written, even when the gate is NOT_READY", async () => {
    const { root, runId } = await notReadyRun();
    const outPath = join(root, "qa-junit.xml");

    const result = await runCli(["export", "--root", root, "--run-id", runId, "--format", "junit", "--out", outPath], { cwd: root });

    // Exporting SUCCEEDED. The gate's own verdict travels in the projection and the sidecar, never in
    // this exit code: `workflow run` is the command that carries a NOT_READY gate as exit 1.
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(JSON.parse(result.stdout)).toMatchObject({ format: "junit", outPath, sidecarPath: `${outPath}.provenance.json`, recommendation: "NOT_READY" });
    expect(await readFile(outPath, "utf8")).toContain("<testsuites");
    expect(JSON.parse(await readFile(`${outPath}.provenance.json`, "utf8"))).toMatchObject({ projection: "junit", runId });
  });

  // Each row asserts the REFUSAL's own message as well as the code, because `exitCode` alone cannot
  // tell a refusal by this command apart from Commander answering "unknown command" with the same 3.
  it.each([
    ["an unknown format", (built: { root: string; runId: string }) => ["export", "--root", built.root, "--run-id", built.runId, "--format", "tap", "--out", join(built.root, "x.tap")], /junit or sarif/i],
    ["an --out inside the run workspace", (built: { root: string; runId: string }) => ["export", "--root", built.root, "--run-id", built.runId, "--format", "junit", "--out", join(built.root, "qa-results", built.runId, "inputs", "x.xml")], /inside .*qa-results/i],
  ])("exits 3 for %s", async (_label, argv, message) => {
    const built = await notReadyRun();

    const result = await runCli(argv(built), { cwd: built.root });

    expect(result.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(result.stderr).toMatch(message);
  });

  it("exits 3 for a run that has no release gate", async () => {
    const built = await runWithoutGate();

    const result = await runCli(["export", "--root", built.root, "--run-id", built.runId, "--format", "junit", "--out", join(built.root, "x.xml")], { cwd: built.root });

    expect(result.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(result.stderr).toMatch(/release gate/i);
  });

  /**
   * MEASURED, not assumed, and deliberately NOT special-cased for this command. An unknown run id never
   * reaches `exportProjection` at all: `RunWorkspace.open` refuses it directly (`core/run-workspace.ts`),
   * naming the run rather than leaking the raw ENOENT its `realpath` used to throw — byte for byte what
   * `validate`, `approval record` and `attestation record` already get from the same open call. Making
   * `export` special-case this itself would put one command out of step with every sibling that shares it.
   */
  it("leaves an unknown run on the same exit code every other run-scoped command gives it", async () => {
    const built = await notReadyRun();

    const result = await runCli(["export", "--root", built.root, "--run-id", "RUN-DOES-NOT-EXIST", "--format", "junit", "--out", join(built.root, "x.xml")], { cwd: built.root });

    expect(result.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(result.stderr).not.toContain("ENOENT");
    expect(result.stderr).toMatch(/RUN-DOES-NOT-EXIST.*was not found/i);
  });

  it("still exits 0 when a registered runner report is unreadable, but says on stderr what it could not read", async () => {
    const { root, runId } = await notReadyRun("{ not json");
    const outPath = join(root, "qa.sarif");

    const result = await runCli(["export", "--root", root, "--run-id", runId, "--format", "sarif", "--out", outPath], { cwd: root });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stderr).toMatch(/could not be read as a sanitized runner report/i);
    expect((JSON.parse(result.stdout) as { unreadableRunnerReports: unknown[] }).unreadableRunnerReports).toHaveLength(1);
    expect(JSON.parse(await readFile(outPath, "utf8"))).toMatchObject({ version: "2.1.0" });
  });

  /**
   * The other degradation this command must announce, and the one that was silent: a SARIF file that
   * validates, exits 0, and places NONE of the failures it reports. `unreadableRunnerReports` is empty
   * here — the payload read perfectly — so the existing note says nothing, and a code-scanning UI shows
   * every failure attached to the repository with no file to open.
   */
  it("still exits 0 when no observed failure could be placed in a file, but says so on stderr", async () => {
    const { root, runId } = await notReadyRun(undefined, ["TC-CHECKOUT"]);
    const outPath = join(root, "unplaced.sarif");

    const result = await runCli(["export", "--root", root, "--run-id", runId, "--format", "sarif", "--out", outPath], { cwd: root });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stderr).toMatch(/name no source file/i);
    expect(result.stderr).not.toMatch(/could not be read as a sanitized runner report/i);
    expect((JSON.parse(result.stdout) as { observedResultsWithoutLocation: number }).observedResultsWithoutLocation).toBe(1);
  });

  /**
   * THE PARTIAL SHAPE, which is what keeps the note's wording honest. The count is per RESULT, not per
   * run, so a run can place some observed failures and not others — and the note first shipped saying
   * "The run recorded no spec location it could vouch for" and pointing at `--root` as though it were the
   * only cause. In this run that sentence is simply false: `e2e/checkout.spec.ts` is placed and sits in
   * the same document, and `--root` is perfectly correct — TC-SEARCH is unplaced because the report never
   * names a spec for it, which is what an execution that ran a case its report does not describe looks
   * like.
   *
   * Both wording assertions live HERE rather than on the 1-of-1 row above, so reverting the scoping
   * reddens this case alone and the mutation says exactly which shape it broke.
   */
  it("scopes the note to the failures it could not place, when the projection placed the others", async () => {
    const { root, runId } = await notReadyRun(
      (created) => sanitizedReport(join(created, "e2e"), [{ testCaseId: "TC-CHECKOUT", file: "checkout.spec.ts" }]),
      ["TC-CHECKOUT", "TC-SEARCH"],
    );
    const outPath = join(root, "partial.sarif");

    const result = await runCli(["export", "--root", root, "--run-id", runId, "--format", "sarif", "--out", outPath], { cwd: root });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect((JSON.parse(result.stdout) as { observedResultsWithoutLocation: number }).observedResultsWithoutLocation).toBe(1);
    // The shape really is partial: one of the two observed failures carries a location. Without this the
    // case could pass as an accidental 1-of-1 and prove nothing about scoping.
    const sarif = JSON.parse(await readFile(outPath, "utf8")) as { runs: [{ results: { ruleId: string; locations?: { physicalLocation: { artifactLocation: { uri: string } } }[] }[] }] };
    const observed = sarif.runs[0].results.filter((entry) => entry.ruleId === "observed-failure");
    expect(observed).toHaveLength(2);
    expect(observed.flatMap((entry) => entry.locations ?? []).map((location) => location.physicalLocation.artifactLocation.uri)).toEqual(["e2e/checkout.spec.ts"]);
    // Scoped to the counted results — "those failures", "For these" — and NOT a claim about the run.
    expect(result.stderr).toMatch(/for these the run recorded no spec location/i);
    // Hedged: one likely cause among several, never `--root` as the only one to check.
    expect(result.stderr).toMatch(/cannot say which reason applied/i);
    expect(result.stderr).toMatch(/likeliest/i);
  });

  /** The note is CONDITIONAL, and this is the run that proves it: same command, no observed failure at
   *  all, so nothing is unplaced and stderr must stay silent rather than announcing a zero. */
  it("says nothing on stderr when there is no unplaced observed failure to announce", async () => {
    const { root, runId } = await notReadyRun();
    const outPath = join(root, "quiet.sarif");

    const result = await runCli(["export", "--root", root, "--run-id", runId, "--format", "sarif", "--out", outPath], { cwd: root });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stderr).toBe("");
    expect((JSON.parse(result.stdout) as { observedResultsWithoutLocation: number }).observedResultsWithoutLocation).toBe(0);
  });
});
