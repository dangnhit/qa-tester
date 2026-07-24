import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { sha256Text } from "../../src/core/checksum.js";
import { RunWorkspace, type WorkspaceDiagnostic } from "../../src/core/run-workspace.js";
import { annotateScreenshot } from "../../src/evidence/annotator.js";
import type { ArtifactType } from "../../src/contracts/types.js";

// ---------------------------------------------------------------------------
// Task 7 (Phase 1) golden for `inspectWorkspaceState` (run-workspace.ts:298).
//
// `inspectWorkspaceState` is the module-private read-path scanner that Phase 2
// will extract. It is observable only through the public `RunWorkspace` methods
// that wrap it: `validate()` surfaces its diagnostics, and
// `readRegisteredArtifacts()` throws unless the scanner produced ZERO
// diagnostics (so a successful read proves a clean scan). These goldens lock the
// scanner's output for a clean run and a diagnostic run so the Phase 2
// extraction can prove it changed nothing.
//
// Determinism: artifact IDs are ULIDs and file paths embed them, so every
// generated ID token is collapsed to "<ID>" before assertion, and diagnostics
// are sorted. No timestamps or absolute paths appear in the asserted output.
// ---------------------------------------------------------------------------

const roots: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "qa-inspect-state-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const environmentProfile = {
  artifactType: "environment-profile",
  schemaVersion: "1.0.0",
  producerVersion: "1.0.0",
  environmentProfileId: "env-test",
  name: "Test",
  classification: "test",
  baseUrl: "https://test.example.test",
  productionReadOnly: false,
} as const;

function testCase(id: string) {
  return {
    artifactType: "test-case",
    schemaVersion: "1.0.0",
    producerVersion: "1.0.0",
    testCaseId: id,
    revisionId: `REV-${id}`,
    instanceId: `${id}--INSTANCE-1`,
    title: `Test ${id}`,
    steps: [{ id: "step-1", action: "navigate", sideEffect: "none" }],
    coverage: {
      requirementId: "REQ-TEST", role: "member", behavior: "test behavior", browser: "chromium",
      viewport: { width: 1440, height: 900 }, accessibilityMethod: null, risk: "low", outcome: "test outcome",
    },
  };
}

function testResult(workspace: RunWorkspace, testCaseId: string, attemptId: string) {
  return {
    artifactType: "test-result",
    schemaVersion: "1.0.0",
    producerVersion: "1.0.0",
    attemptId,
    runId: workspace.runId,
    testCaseId,
    testCaseRevisionId: `REV-${testCaseId}`,
    testCaseInstanceId: `${testCaseId}--INSTANCE-1`,
    status: "PASSED",
    failureClassification: "NONE",
    steps: [{ stepId: "step-1", status: "PASSED", durationMs: 1 }],
    startedAt: "2026-07-23T12:34:56.000Z",
    finishedAt: "2026-07-23T12:35:56.000Z",
  };
}

async function registerDocument(workspace: RunWorkspace, type: ArtifactType, name: string, value: unknown, relationships: string[] = []) {
  const sourcePath = join(workspace.root, name);
  await writeFile(sourcePath, JSON.stringify(value));
  return workspace.registerArtifact({ type, sourcePath, relationships });
}

/** A valid execute-mode workspace: environment profile + one test case + two runtime results. */
async function buildExecuteWorkspace() {
  const directory = await root();
  const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile });
  const testcase = await registerDocument(workspace, "test-case", "case.json", testCase("TC-X"));
  const first = await registerDocument(workspace, "test-result", "result-1.json", testResult(workspace, "TC-X", "ATTEMPT-1"), [testcase.id]);
  const second = await registerDocument(workspace, "test-result", "result-2.json", testResult(workspace, "TC-X", "ATTEMPT-2"), [testcase.id]);
  return { directory, workspace, testcase, first, second };
}

// ULID tokens (Crockford base32, 26 chars) are the only non-deterministic
// substrings in the scanner's paths and messages; collapse them for stability.
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/g;
function scrub(text: string): string {
  return text.replace(ULID, "<ID>");
}

function normalizeDiagnostic(diagnostic: WorkspaceDiagnostic): WorkspaceDiagnostic {
  return {
    code: diagnostic.code,
    message: scrub(diagnostic.message),
    ...(diagnostic.relativePath === undefined ? {} : { relativePath: scrub(diagnostic.relativePath) }),
  };
}

function sortDiagnostics(diagnostics: readonly WorkspaceDiagnostic[]): WorkspaceDiagnostic[] {
  return diagnostics
    .map(normalizeDiagnostic)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function solidPng(width = 120, height = 80): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } } }).png().toBuffer();
}

function rawScreenshotDescriptor(workspace: RunWorkspace, binaries: readonly { id: string; relativePath: string; sha256: string; mediaType?: string }[]) {
  const primary = binaries[0];
  return {
    artifactType: "evidence", schemaVersion: "1.0.0", producerVersion: "0.1.0", evidenceId: "01HZX3Y6W4YB5FWG0RY9Q8Q2K7", runId: workspace.runId,
    attemptId: "ATTEMPT-1", testCaseId: "TC-X", testCaseRevisionId: "REV-TC-X", testCaseInstanceId: "TC-X--INSTANCE-1", kind: "screenshot",
    capturedAt: "2026-07-23T00:00:00.000Z", sha256: primary?.sha256, relativePath: primary?.relativePath, mediaType: primary?.mediaType,
    binaryArtifactIds: binaries.map((binary) => binary.id),
    binaryArtifacts: binaries.map((binary) => ({ id: binary.id, relativePath: binary.relativePath, sha256: binary.sha256, mediaType: binary.mediaType })),
    provenance: { captureType: "screenshot", dimensions: { width: 120, height: 80 }, dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 120, height: 80 }, url: "https://test.example.test", viewport: { width: 120, height: 80 }, browser: "chromium", build: "build-1", capturedAt: "2026-07-23T00:00:00.000Z", testcaseId: "TC-X" },
  };
}

/** A valid execute-mode workspace carrying a DERIVED (annotated) screenshot: test case + one result +
 *  a raw screenshot bundle (source descriptor + image/png binary) + an annotated evidence whose
 *  `derivation` binds the raw descriptor/binary checksums. The derived descriptor thus has both an
 *  attempt binding (block A) AND a derivation (block B). */
async function buildDerivedScreenshotWorkspace() {
  const directory = await root();
  const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile });
  const testcase = await registerDocument(workspace, "test-case", "case.json", testCase("TC-X"));
  const result = await registerDocument(workspace, "test-result", "result.json", testResult(workspace, "TC-X", "ATTEMPT-1"), [testcase.id]);
  const rawBundle = await workspace.registerEvidenceBundle({
    binaries: [{ filename: "raw.png", contents: await solidPng(), mediaType: "image/png", captureType: "screenshot", dimensions: { width: 120, height: 80 } }],
    relationships: [result.id],
    descriptor: (binaries) => rawScreenshotDescriptor(workspace, binaries),
  });
  const rawBinary = rawBundle.binaries[0];
  if (!rawBinary) throw new Error("Expected raw evidence binary");
  const derived = await annotateScreenshot({
    workspace,
    rawEvidenceDescriptorId: rawBundle.descriptor.id,
    rawBinaryArtifactId: rawBinary.id,
    annotations: [{ id: "one", x: 10, y: 10, width: 30, height: 20, label: "Input", cssBox: { x: 10, y: 10, width: 30, height: 20 } }],
  });
  return { workspace, derivedDescriptorId: derived.descriptorArtifactId };
}

// ---------------------------------------------------------------------------
// Task 15c fix lock: evidence READ must stay behavior-preserving relative to the
// pre-Task-15c (commit d640fa1) inline scanner. That code ran the attempt-binding
// check (block A) and the derived-screenshot derivation check (block B) as two
// INDEPENDENT `if`s, so a derived screenshot with BOTH tampered emits TWO
// INVALID_REFERENCE diagnostics in a single pass. Migrating evidence read onto the
// return-first semantic-rule table (commit 6011f5e) short-circuited that to ONE
// diagnostic — an unsanctioned behavior change. This test constructs the
// doubly-tampered case and asserts BOTH diagnostics survive (FAILS at 6011f5e with
// one; PASSES once read is restored inline).
// ---------------------------------------------------------------------------
describe("inspectWorkspaceState — evidence read two-diagnostic lock (Task 15c fix)", () => {
  it("emits BOTH the attempt-binding and derivation diagnostics for a doubly-tampered derived screenshot", async () => {
    const { workspace, derivedDescriptorId } = await buildDerivedScreenshotWorkspace();

    // Tamper the persisted derived descriptor: break block A (attempt identity — an
    // attemptId no registered test-result carries) AND block B (derivation raw
    // checksum), then re-checksum the manifest record so both survive the integrity
    // gate and reach the read semantic checks.
    const manifestPath = join(workspace.path, "artifact-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; sha256: string; relativePath: string }[] };
    const record = manifest.artifacts.find((entry) => entry.id === derivedDescriptorId);
    if (!record) throw new Error("Expected the derived evidence descriptor in the manifest");
    const descriptorPath = join(workspace.path, record.relativePath);
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as Record<string, unknown>;
    descriptor.attemptId = "GHOST-ATTEMPT";
    (descriptor.derivation as Record<string, unknown>).sourceRawSha256 = "0".repeat(64);
    const tampered = JSON.stringify(descriptor);
    await writeFile(descriptorPath, tampered);
    record.sha256 = sha256Text(tampered);
    await writeFile(manifestPath, JSON.stringify(manifest));

    const validation = await workspace.validate("execute");
    expect(validation.valid).toBe(false);
    const derivedDiagnostics = sortDiagnostics(validation.diagnostics.filter((diagnostic) => diagnostic.relativePath === record.relativePath));
    expect(derivedDiagnostics).toEqual([
      { code: "INVALID_REFERENCE", message: "Derived screenshot must preserve exact source descriptor and raw checksum relationships", relativePath: scrub(record.relativePath) },
      { code: "INVALID_REFERENCE", message: "Evidence must reference one exact registered attempt and matching testcase identity", relativePath: scrub(record.relativePath) },
    ]);

    await workspace.close();
  });
});

describe("inspectWorkspaceState — clean run golden", () => {
  it("reports no diagnostics and the exact set of valid registered artifacts", async () => {
    const { workspace } = await buildExecuteWorkspace();

    // A successful readRegisteredArtifacts() proves inspectWorkspaceState
    // produced zero diagnostics (it throws otherwise).
    const registered = await workspace.readRegisteredArtifacts();
    const state = registered
      .map((entry) => ({
        type: entry.record.type,
        relativePath: scrub(entry.record.relativePath),
        provenance: entry.record.provenance,
        relationships: entry.record.relationships.length,
      }))
      .sort((left, right) => `${left.type}|${left.relativePath}|${left.relationships}`.localeCompare(`${right.type}|${right.relativePath}|${right.relationships}`));

    expect(state).toEqual([
      { type: "environment-profile", relativePath: "inputs/<ID>-environment-profile.json", provenance: "runtime", relationships: 0 },
      { type: "test-case", relativePath: "inputs/<ID>-test-case.json", provenance: "agent-draft", relationships: 0 },
      { type: "test-result", relativePath: "inputs/<ID>-test-result.json", provenance: "agent-draft", relationships: 1 },
      { type: "test-result", relativePath: "inputs/<ID>-test-result.json", provenance: "agent-draft", relationships: 1 },
    ]);

    // The wrapping validate() adds no profile diagnostics for a complete execute run.
    expect(await workspace.validate("execute")).toEqual({ valid: true, diagnostics: [] });

    await workspace.close();
  });
});

describe("inspectWorkspaceState — diagnostic run golden", () => {
  it("reports the injected orphan file and rechecksummed dangling test-result reference", async () => {
    const { workspace, second } = await buildExecuteWorkspace();

    // Tamper-and-rechecksum (mirrors tests/core/run-workspace.test.ts): rewrite
    // the second result so it references a test case that is not registered,
    // then update the manifest checksum so it passes the checksum gate and is
    // instead caught as a dangling reference (INVALID_REFERENCE). The first
    // result stays valid, so the execute profile stays satisfied and no profile
    // diagnostic is added.
    const tampered = `${JSON.stringify(testResult(workspace, "TC-GHOST", "ATTEMPT-2"), null, 2)}\n`;
    await writeFile(second.absolutePath, tampered);
    const manifestPath = join(workspace.path, "artifact-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; sha256: string }[] };
    const record = manifest.artifacts.find((entry) => entry.id === second.id);
    if (!record) throw new Error("Expected the tampered test-result record in the manifest");
    record.sha256 = sha256Text(tampered);
    await writeFile(manifestPath, JSON.stringify(manifest));

    // Inject an unregistered orphan file under inputs/.
    await writeFile(join(workspace.path, "inputs", "orphan.json"), "{}");

    const validation = await workspace.validate("execute");
    expect(validation.valid).toBe(false);
    expect(sortDiagnostics(validation.diagnostics)).toEqual([
      { code: "INVALID_REFERENCE", message: "Test result must reference exactly one registered test case revision and instance", relativePath: "inputs/<ID>-test-result.json" },
      { code: "ORPHAN_FILE", message: "Unregistered file inputs/orphan.json", relativePath: "inputs/orphan.json" },
    ]);

    await workspace.close();
  });
});
