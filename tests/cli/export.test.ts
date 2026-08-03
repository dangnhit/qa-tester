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

/**
 * A finalized run whose gate is NOT_READY. The operational Evidence Gap is what makes it so: it becomes
 * a shared blocker, and `NO_SHARED_BLOCKERS` is a hard failure. The `runner-report` evidence bundle is
 * registered because the export operation reads the file behind it — `report` is parameterised only so
 * the unreadable-payload case can register something unparseable through the real registration path.
 *
 * Redeclared here rather than imported from `tests/operations/export-projection.test.ts`: fixtures are
 * not shared across test files on this branch.
 */
async function notReadyRun(report = '{ "sanitization": { "policy": "p", "removed": [], "note": "" }, "suites": [] }'): Promise<{ root: string; runId: string }> {
  const root = await mkdtemp(join(tmpdir(), "qa-export-cli-")); roots.push(root);
  const workspace = await RunWorkspace.create({ root, mode: "execute", environmentProfile: environment });
  await workspace.registerEvidenceBundle({
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
    type: "evidence-gap", relationships: [],
    value: { artifactType: "evidence-gap", schemaVersion: "2.0.0", producerVersion: "0.1.0", evidenceGapId: "GAP-1", runId: workspace.runId, scope: "operational", reason: "Trace retention refused by the environment profile", affectedClaim: "the checkout total shown to a signed-in buyer" },
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
});
