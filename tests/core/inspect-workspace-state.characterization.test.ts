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

/** Rewrites a registered artifact's persisted payload and re-checksums its manifest record, so the
 *  tampered value survives the integrity gate and reaches the read-path semantic checks. Several
 *  states below are unreachable through the write path (which refuses them at registration), so
 *  tamper-and-rechecksum is the only way to construct them. */
async function tamper(workspace: RunWorkspace, artifact: { id: string; absolutePath: string }, value: unknown): Promise<void> {
  const contents = JSON.stringify(value);
  await writeFile(artifact.absolutePath, contents);
  const manifestPath = join(workspace.path, "artifact-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; sha256: string }[] };
  const record = manifest.artifacts.find((entry) => entry.id === artifact.id);
  if (!record) throw new Error(`Expected artifact ${artifact.id} in the manifest`);
  record.sha256 = sha256Text(contents);
  await writeFile(manifestPath, JSON.stringify(manifest));
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
    artifactType: "evidence", schemaVersion: "2.0.0", producerVersion: "0.1.0", evidenceId: "01HZX3Y6W4YB5FWG0RY9Q8Q2K7", runId: workspace.runId,
    subject: { kind: "attempt", attemptId: "ATTEMPT-1", testCaseId: "TC-X", testCaseRevisionId: "REV-TC-X", testCaseInstanceId: "TC-X--INSTANCE-1" }, kind: "screenshot",
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
    (descriptor.subject as Record<string, unknown>).attemptId = "GHOST-ATTEMPT";
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

// ---------------------------------------------------------------------------
// Task 26 (Phase 4 / D14): the per-artifact revalidation fan-out is now bounded to a concurrency of 16
// (a shared-cursor worker pool) instead of an unbounded `Promise.all`. These goldens exercise a
// workspace with MORE artifacts than the cap, so at least two concurrency "waves" run, and assert the
// bounded fan-out is behaviorally identical to the unbounded version it replaced: every artifact is
// processed exactly once, results land in registration order, and diagnostics are produced (or not) for
// artifacts regardless of which wave picks them up.
// ---------------------------------------------------------------------------
describe("inspectWorkspaceState — bounded fan-out golden (Task 26 / D14)", () => {
  const artifactCount = 24; // > the 16-wide concurrency cap, forcing a second wave
  const caseId = (index: number) => `TC-${String(index).padStart(3, "0")}`;

  async function buildManyArtifactWorkspace() {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const registered = [];
    for (let index = 0; index < artifactCount; index += 1) {
      registered.push(await registerDocument(workspace, "test-case", `case-${caseId(index)}.json`, testCase(caseId(index))));
    }
    return { workspace, registered };
  }

  it("returns all artifacts from a many-artifact workspace in registration order with no diagnostics", async () => {
    const { workspace } = await buildManyArtifactWorkspace();

    const registeredArtifacts = await workspace.readRegisteredArtifacts();
    const cases = registeredArtifacts.filter((artifact) => artifact.record.type === "test-case");
    expect(cases.map((artifact) => artifact.value.testCaseId)).toEqual(
      Array.from({ length: artifactCount }, (_, index) => caseId(index)),
    );
    expect(await workspace.validate("plan")).toEqual({ valid: true, diagnostics: [] });

    await workspace.close();
  });

  it("still reports every diagnostic for artifacts tampered across both concurrency waves", async () => {
    const { workspace, registered } = await buildManyArtifactWorkspace();

    // Indices 0 and 15 are claimed by the first wave (the initial 16 workers); 16 and 23 can only be
    // reached once a first-wave worker frees up and pulls the next item — proving the pool keeps
    // draining past the cap instead of dropping anything.
    const tamperedIndices = [0, 15, 16, 23];
    for (const index of tamperedIndices) {
      const artifact = registered[index];
      if (!artifact) throw new Error(`Expected registered artifact at index ${index}`);
      await writeFile(artifact.absolutePath, "not the registered contents");
    }

    const validation = await workspace.validate("plan");
    expect(validation.valid).toBe(false);
    expect(sortDiagnostics(validation.diagnostics)).toEqual(sortDiagnostics(tamperedIndices.map((index) => {
      const artifact = registered[index];
      if (!artifact) throw new Error(`Expected registered artifact at index ${index}`);
      return { code: "CHECKSUM_MISMATCH", message: `Checksum mismatch for ${artifact.relativePath}`, relativePath: artifact.relativePath };
    })));

    await workspace.close();
  });
});

// ---------------------------------------------------------------------------
// Task 26 (Phase 4 / D14): the mediaType hoist investigation. The evidence descriptor <-> binary rule
// (inspect-workspace-state.ts, the `evidenceDescriptors`/`binaryRecords` loop) only cross-checks two
// already-DECLARED values — the manifest's `record.sha256` against the descriptor JSON's declared
// `detail.sha256` — for internal consistency. It never recomputes a hash from the binary's actual file
// bytes. The manifest-level `sha256(absolutePath) !== record.sha256` check (which runs BEFORE the
// `mediaType` branch) is the ONLY read-path check that does. This test proves that gap in the negative
// space: a binary's file bytes are tampered in place while its manifest record AND its descriptor's
// declared checksum are left untouched (both still reflect the pre-tamper hash) — the same tamper shape
// the hoist would have made undetectable. Under the current (non-hoisted) code this is still caught via
// CHECKSUM_MISMATCH; this golden pins that so a future hoist attempt fails loudly instead of silently.
// ---------------------------------------------------------------------------
describe("inspectWorkspaceState — binary integrity is still caught (Task 26 / D14 hoist investigation)", () => {
  it("detects a tampered evidence binary via the manifest checksum even though its descriptor binding was never touched", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "execute", environmentProfile });
    const testcase = await registerDocument(workspace, "test-case", "case.json", testCase("TC-X"));
    const result = await registerDocument(workspace, "test-result", "result.json", testResult(workspace, "TC-X", "ATTEMPT-1"), [testcase.id]);
    const bundle = await workspace.registerEvidenceBundle({
      binaries: [{ filename: "raw.png", contents: await solidPng(), mediaType: "image/png", captureType: "screenshot", dimensions: { width: 120, height: 80 } }],
      relationships: [result.id],
      descriptor: (binaries) => rawScreenshotDescriptor(workspace, binaries),
    });
    const binary = bundle.binaries[0];
    if (!binary) throw new Error("Expected raw evidence binary");

    // Tamper ONLY the binary's actual file bytes. Neither the manifest record's `sha256` nor the
    // descriptor's declared `binaryArtifacts[0].sha256` are touched, so any check that compares those
    // two DECLARED values against each other (rather than recomputing from disk) would see them agree
    // and find nothing wrong.
    await writeFile(binary.absolutePath, await solidPng(121, 81));

    const validation = await workspace.validate("execute");
    expect(validation.valid).toBe(false);
    // CHECKSUM_MISMATCH is the ONLY diagnostic that comes from actually recomputing the binary's hash.
    // The two INVALID_REFERENCE diagnostics are a downstream CASCADE of that: once the binary is
    // invalidated, it drops out of the descriptor rule's valid `binaryRecords` pool, so the descriptor
    // can no longer find its binary at all. Without the manifest-level hash check (i.e. after the
    // literal "hoist mediaType above sha256"), the binary would stay `valid: true`, stay in
    // `binaryRecords`, and the descriptor rule's own comparison (`binary.record.sha256 !==
    // detail.sha256`) would still pass — both are untouched DECLARED values that still agree with each
    // other, just not with the actual file bytes. So NONE of these three diagnostics would fire and
    // `validate()` would report `{ valid: true, diagnostics: [] }` on a genuinely tampered binary. That
    // is precisely why the hoist is unsafe (see the comment above the `sha256` call in
    // inspect-workspace-state.ts).
    expect(sortDiagnostics(validation.diagnostics)).toEqual(sortDiagnostics([
      { code: "CHECKSUM_MISMATCH", message: `Checksum mismatch for ${binary.relativePath}`, relativePath: binary.relativePath },
      { code: "INVALID_REFERENCE", message: "Evidence descriptor does not match its registered binary", relativePath: bundle.descriptor.relativePath },
      { code: "INVALID_REFERENCE", message: "Evidence descriptor does not match its designated primary binary", relativePath: bundle.descriptor.relativePath },
    ]));

    await workspace.close();
  });
});

// ---------------------------------------------------------------------------
// Task 30: the `.find()`/`.filter()`-per-attempt scans in the read path are now `Map` indices
// (`src/core/artifact-index.ts`). Three properties of that conversion are not covered by the goldens
// above and would each fail SILENTLY — with every other test still green — so they are pinned here.
// ---------------------------------------------------------------------------

// (1) MULTIPLICITY. The AMBIGUOUS_ATTEMPT check exists to catch two registered results claiming one
// attempt. An index keyed to a single artifact per attempt (the obvious wrong shape) would collapse
// the duplicate and emit nothing, so the workspace would validate clean. This asserts the full
// bucket still survives the lookup: BOTH definitions are invalidated, one diagnostic each.
describe("inspectWorkspaceState — AMBIGUOUS_ATTEMPT through the shared attempt index (Task 30)", () => {
  it("invalidates every definition of a duplicated attempt id, not just the first", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const testcase = await registerDocument(workspace, "test-case", "case.json", testCase("TC-X"));
    const first = await registerDocument(workspace, "test-result", "result-1.json", testResult(workspace, "TC-X", "ATTEMPT-1"), [testcase.id]);
    const second = await registerDocument(workspace, "test-result", "result-2.json", testResult(workspace, "TC-X", "ATTEMPT-2"), [testcase.id]);

    // The write path refuses a duplicate attempt id outright ("Test result attempt ID is already
    // registered and would be ambiguous"), so the collision is only constructible by tampering.
    await tamper(workspace, second, testResult(workspace, "TC-X", "ATTEMPT-1"));

    const validation = await workspace.validate("plan");
    expect(validation.valid).toBe(false);
    expect(sortDiagnostics(validation.diagnostics)).toEqual(sortDiagnostics([
      { code: "AMBIGUOUS_ATTEMPT", message: "Attempt ATTEMPT-1 has multiple definitions", relativePath: first.relativePath },
      { code: "AMBIGUOUS_ATTEMPT", message: "Attempt ATTEMPT-1 has multiple definitions", relativePath: second.relativePath },
    ]));

    await workspace.close();
  });
});

// (2) THE FIXPOINT POOL. `inspectWorkspaceState` runs a `while (changed)` fixpoint in which the valid
// pool SHRINKS between passes, and the in-fixpoint evidence block reads the attempt index built from
// that pool. The index is therefore rebuilt on every pass. An index hoisted ABOVE the loop — the
// natural "build it once" optimisation — would keep serving pass 1's larger pool, so evidence bound
// to a test result invalidated in pass 1 would still resolve its attempt in pass 2 and pass the
// in-fixpoint check. Verified against that exact regression: the pass-2 diagnostic below disappears
// and the LATER, post-fixpoint `exactAttemptEvidenceBinding` check reports the artifact instead, with
// its own different message ("Evidence must HAVE one exact test-result relationship ..."). So the
// visible damage is twofold — the diagnostic set changes, and the fixpoint reaches its resting point
// one pass early, which is what would let anything cascading off this evidence stay valid.
describe("inspectWorkspaceState — the fixpoint attempt index must be rebuilt per pass (Task 30)", () => {
  it("hides an attempt invalidated in pass N from the evidence attempt lookup in pass N+1", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const testcase = await registerDocument(workspace, "test-case", "case.json", testCase("TC-X"));
    const result = await registerDocument(workspace, "test-result", "result.json", testResult(workspace, "TC-X", "ATTEMPT-1"), [testcase.id]);
    const bundle = await workspace.registerEvidenceBundle({
      binaries: [{ filename: "raw.png", contents: await solidPng(), mediaType: "image/png", captureType: "screenshot", dimensions: { width: 120, height: 80 } }],
      relationships: [result.id],
      descriptor: (binaries) => rawScreenshotDescriptor(workspace, binaries),
    });
    const binary = bundle.binaries[0];
    if (!binary) throw new Error("Expected raw evidence binary");

    // Break ONLY the test result, and only in a way the SEMANTIC layer catches: its aggregate status
    // no longer derives from its steps. It still parses, still matches its schema, and still passes
    // the checksum gate, so it enters the fixpoint VALID and is invalidated during pass 1 — which is
    // the precondition the pass-2 lookup depends on. The evidence is left completely untouched.
    await tamper(workspace, result, { ...testResult(workspace, "TC-X", "ATTEMPT-1"), status: "FAILED", failureClassification: "PRODUCT_DEFECT" });

    const validation = await workspace.validate("plan");
    expect(validation.valid).toBe(false);
    expect(sortDiagnostics(validation.diagnostics)).toEqual(sortDiagnostics([
      // Pass 1: the test result loses its own binding.
      { code: "INVALID_REFERENCE", message: "Test result must be derived from the exact ordered canonical steps and aggregate status", relativePath: result.relativePath },
      // Pass 2: the shrunken pool no longer answers the evidence's attempt lookup. This is the line
      // that disappears if the index is built once outside the fixpoint.
      { code: "INVALID_REFERENCE", message: "Evidence must reference one exact registered attempt and matching testcase identity", relativePath: bundle.descriptor.relativePath },
      // Post-fixpoint: the now-invalid descriptor no longer claims its binary.
      { code: "INVALID_REFERENCE", message: "Evidence binary must be referenced exactly once by a canonical evidence descriptor", relativePath: binary.relativePath },
    ]));

    await workspace.close();
  });
});

// (3) MULTIPLICITY, the identity-triple index. Same hazard as (1) for the other index: `testResultRule`
// reads `matches.length === 1` on the test-case identity triple, so an index that kept one test case
// per triple would report a clean single match for an AMBIGUOUS revision+instance and let the result
// bind. The existing goldens only cover the ZERO-match direction (a dangling `TC-GHOST` reference), so
// the duplicate direction is pinned here.
describe("inspectWorkspaceState — ambiguous test-case identity through the shared triple index (Task 30)", () => {
  it("rejects a result whose identity triple is claimed by two registered test cases", async () => {
    const directory = await root();
    const workspace = await RunWorkspace.create({ root: directory, mode: "plan", environmentProfile });
    const testcase = await registerDocument(workspace, "test-case", "case.json", testCase("TC-X"));
    const result = await registerDocument(workspace, "test-result", "result.json", testResult(workspace, "TC-X", "ATTEMPT-1"), [testcase.id]);
    // A second case carrying the SAME identity triple. Its title differs only because the workspace
    // rejects a byte-identical duplicate outright ("Completed artifacts are immutable"), and it is
    // registered AFTER the result because the write rule refuses a result whose triple already
    // matches two cases — so the collision can only be reached in this order.
    await registerDocument(workspace, "test-case", "case-duplicate.json", { ...testCase("TC-X"), title: "Test TC-X (rival revision)" });

    const validation = await workspace.validate("plan");
    expect(validation.valid).toBe(false);
    expect(sortDiagnostics(validation.diagnostics)).toEqual(sortDiagnostics([
      { code: "INVALID_REFERENCE", message: "Test result must reference exactly one registered test case revision and instance", relativePath: result.relativePath },
    ]));

    await workspace.close();
  });
});
