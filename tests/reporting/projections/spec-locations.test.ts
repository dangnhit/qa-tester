import { describe, expect, it } from "vitest";

import { buildProjectionModel, type ProjectionArtifact } from "../../../src/reporting/projections/projection-model.js";
import { specLocationsByEntryIdentity } from "../../../src/reporting/projections/spec-locations.js";

// Task 1's `gateArtifact`/`base` fixtures, redeclared locally rather than imported from
// `projection-model.test.ts` (per the brief: fixtures are not shared across test files).
const gateArtifact: ProjectionArtifact = {
  record: { id: "gate-1", sha256: "a".repeat(64), type: "release-gate" },
  value: {
    artifactType: "release-gate", recommendation: "NOT_READY", protectedEnvironment: false,
    sourceArtifacts: [{ id: "tr-1", sha256: "b".repeat(64), type: "test-result" }],
    ruleInputs: { artifactsValid: true, coverage: { requiredMissing: ["COV-1"], optionalGaps: [], requiredHighRisk: [] }, bugs: [], sharedBlockers: [] },
    verdicts: [{ rule: "REQUIRED_COVERAGE_COMPLETE", passed: false, reason: "Required coverage missing: COV-1." }],
  },
};

const base = { runId: "RUN-1", producerVersion: "0.3.0", generatedAt: "2026-07-29T00:00:00.000Z" };

// Task 1's `drivenAttempt` fixture (lane 1), redeclared locally to prove lane 1 is never joined.
const drivenAttempt: ProjectionArtifact = {
  record: { id: "tr-1", sha256: "b".repeat(64), type: "test-result", provenance: "runtime-execution" },
  value: {
    artifactType: "test-result", attemptId: "ATT-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1",
    status: "FAILED", failureClassification: "PRODUCT_DEFECT", observedEngine: "chromium",
    steps: [{ stepId: "S1", status: "FAILED", durationMs: 300 }],
  },
};

// Task 1's `batch` fixture, with the first entry's identity set to TC-1/REV-1/INST-1 on the `api`
// surface -- matching the tag `runnerReport` carries below -- per the brief's Step 2 instructions.
const batchWithTaggedEntry: ProjectionArtifact = {
  record: { id: "batch-1", sha256: "c".repeat(64), type: "test-result-batch", provenance: "runtime-observed" },
  value: {
    artifactType: "test-result-batch", executionId: "EX-1", commitSha: "d".repeat(40), specTreeSha256: "e".repeat(64),
    entries: [
      { entryId: "E-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1", status: "FAILED", failureClassification: "UNDETERMINED", executionSurface: "api", steps: [{ stepId: "S1", status: "FAILED", durationMs: 500 }] },
      { entryId: "E-2", testCaseId: "TC-3", testCaseRevisionId: "REV-3", testCaseInstanceId: "INST-3", status: "NOT_RUN", failureClassification: "NONE", executionSurface: "unit", steps: [{ stepId: "S1", status: "NOT_RUN", durationMs: 0 }] },
    ],
  },
};

// A PAYLOAD, not an artifact: these are the parsed bytes of a registered sanitized runner report, which
// the impure edge reads off disk (`src/operations/export-projection.ts`) because they are registered as
// a binary and no artifact's `.value` ever carries them. Shaped exactly as measured from
// `sanitizeRunnerReport` (src/observed/sanitize-report.ts:99-105,124-134):
// `{ suites: [ { title, file?, line?, column?, suites?: [...], specs?: [{ title, ok, id, file, line, column, tests }] } ] }`.
// One suite, two specs: one tagged matching `batchWithTaggedEntry`'s first entry, one not.
const runnerReport: Readonly<Record<string, unknown>> = {
  sanitization: { policy: "qa-skills/observed-runner-report/v1", removed: [], note: "" },
  suites: [
    {
      title: "checkout.spec.ts",
      specs: [
        { title: "[qa:TC-1/REV-1/INST-1@api] pays with a card", ok: false, id: "spec-1", file: "specs/checkout.spec.ts", line: 42, column: 3, tests: [] },
        { title: "an untagged spec that also ran", ok: true, id: "spec-2", file: "specs/checkout.spec.ts", line: 58, column: 3, tests: [] },
      ],
    },
  ],
};

describe("specLocationsByEntryIdentity", () => {
  it("finds a tagged spec's file and line", () => {
    expect(specLocationsByEntryIdentity([runnerReport]).get("TC-1/REV-1/INST-1@api"))
      .toEqual({ file: "specs/checkout.spec.ts", line: 42 });
  });

  it("returns nothing for an untagged spec, rather than guessing which entry it belongs to", () => {
    expect(specLocationsByEntryIdentity([runnerReport]).size).toBe(1);
  });

  it("returns an empty map when the run registered no sanitized report at all", () => {
    expect(specLocationsByEntryIdentity([]).size).toBe(0);
  });

  // The measured shape that matters most, kept from Task 5 with only its framing corrected. A REAL
  // registered `evidence` artifact's `value` is the descriptor `registerEvidenceBundle` builds
  // (execute-observed-playwright.ts:386-398) -- subject, kind, binaryArtifactIds, binaryArtifacts,
  // provenance -- never the sanitized report's `suites`, which live in the referenced BINARY's file
  // content. Handing this function that descriptor by mistake must find nothing rather than crash or
  // fabricate a match. (Which payloads are ACTUALLY read is now decided by `runnerReportSources` in
  // `src/operations/export-projection.ts`, where the "only an evidence artifact, and only a
  // runner-report one" filter moved along with the file read; its own tests pin that.)
  it("finds nothing in an evidence descriptor handed to it in place of the report it references", () => {
    const descriptor: Readonly<Record<string, unknown>> = {
      artifactType: "evidence", schemaVersion: "3.0.0", evidenceId: "EV-1", runId: "RUN-1",
      subject: { kind: "observed-execution", executionId: "EX-1" }, kind: "runner-report", capturedAt: base.generatedAt,
      sha256: "f".repeat(64), relativePath: "evidence/1-report.json", mediaType: "application/json",
      binaryArtifactIds: ["bin-1"], binaryArtifacts: [{ id: "bin-1", relativePath: "evidence/1-report.json", sha256: "f".repeat(64), mediaType: "application/json" }],
      provenance: { captureType: "runner-report", runner: "playwright", runnerVersion: "1.61.0", exitCode: 0, capturedAt: base.generatedAt },
    };
    expect(specLocationsByEntryIdentity([descriptor]).size).toBe(0);
  });

  it("recurses into a suite nested inside a suite to find a spec several describe blocks deep", () => {
    const nested: Readonly<Record<string, unknown>> = {
      suites: [{
        title: "checkout.spec.ts",
        suites: [{
          title: "checkout flow",
          suites: [{
            title: "card payment",
            specs: [{ title: "[qa:TC-9/REV-9/INST-9@api] deeply nested", ok: false, id: "spec-9", file: "specs/deep.spec.ts", line: 7, column: 5, tests: [] }],
          }],
        }],
      }],
    };
    expect(specLocationsByEntryIdentity([nested]).get("TC-9/REV-9/INST-9@api")).toEqual({ file: "specs/deep.spec.ts", line: 7 });
  });

  it("ignores a malformed suite node rather than crashing", () => {
    expect(specLocationsByEntryIdentity([{ suites: ["not a suite", null, 42] }]).size).toBe(0);
  });

  it("treats a spec with no title at all exactly like an untagged spec", () => {
    const report: Readonly<Record<string, unknown>> = { suites: [{ title: "s", specs: [{ ok: false, id: "spec-notitle", file: "specs/notitle.spec.ts", line: 1, column: 1, tests: [] }] }] };
    expect(specLocationsByEntryIdentity([report]).size).toBe(0);
  });

  // The guard this proves: `typeof spec.title === "string"`. Without it, `RegExp#exec` coerces its
  // argument via `ToString` -- `String(["not really a title", "[qa:TC-X/REV-X/INST-X@api] spurious"])`
  // is `"not really a title,[qa:TC-X/REV-X/INST-X@api] spurious"`, which DOES contain a valid tag and
  // would register a bogus location. An absent title (`.exec(undefined)` -> `.exec("undefined")`) can
  // never distinguish the guarded implementation from an unguarded one; only a non-string value whose
  // coerced form spells out a tag can.
  it("does not let a non-string title fabricate a location through ToString coercion", () => {
    const report: Readonly<Record<string, unknown>> = {
      suites: [{
        title: "s",
        specs: [{
          title: ["not really a title", "[qa:TC-X/REV-X/INST-X@api] spurious"],
          ok: false, id: "spec-8", file: "specs/coerced.spec.ts", line: 1, column: 1, tests: [],
        }],
      }],
    };
    expect(specLocationsByEntryIdentity([report]).has("TC-X/REV-X/INST-X@api")).toBe(false);
  });

  it("skips a malformed tag rather than guessing an identity", () => {
    const report: Readonly<Record<string, unknown>> = { suites: [{ title: "s", specs: [{ title: "[qa:BROKEN incomplete tag] does a thing", ok: false, id: "spec-4", file: "specs/broken.spec.ts", line: 1, column: 1, tests: [] }] }] };
    expect(specLocationsByEntryIdentity([report]).size).toBe(0);
  });

  it("skips a tagged spec with no file, rather than attaching a location with nothing to point at", () => {
    const report: Readonly<Record<string, unknown>> = { suites: [{ title: "s", specs: [{ title: "[qa:TC-5/REV-5/INST-5@api] no file", ok: false, id: "spec-5", file: "", line: 1, column: 1, tests: [] }] }] };
    expect(specLocationsByEntryIdentity([report]).size).toBe(0);
  });

  it("finds a location with no line when the spec carries none", () => {
    const report: Readonly<Record<string, unknown>> = { suites: [{ title: "s", specs: [{ title: "[qa:TC-6/REV-6/INST-6@api] no line", ok: false, id: "spec-6", file: "specs/no-line.spec.ts", column: 1, tests: [] }] }] };
    expect(specLocationsByEntryIdentity([report]).get("TC-6/REV-6/INST-6@api")).toEqual({ file: "specs/no-line.spec.ts" });
  });

  it("skips a duplicate identity claimed by two specs, rather than resolving to whichever came first", () => {
    const report: Readonly<Record<string, unknown>> = {
      suites: [{
        title: "s",
        specs: [
          { title: "[qa:TC-7/REV-7/INST-7@api] first claim", ok: false, id: "spec-7a", file: "specs/a.spec.ts", line: 1, column: 1, tests: [] },
          { title: "[qa:TC-7/REV-7/INST-7@api] second claim", ok: false, id: "spec-7b", file: "specs/b.spec.ts", line: 2, column: 1, tests: [] },
        ],
      }],
    };
    expect(specLocationsByEntryIdentity([report]).has("TC-7/REV-7/INST-7@api")).toBe(false);
  });

  it("skips a duplicate identity claimed by two SEPARATE reports, not just two specs in one", () => {
    const first: Readonly<Record<string, unknown>> = { suites: [{ title: "s", specs: [{ title: "[qa:TC-7/REV-7/INST-7@api] first report", ok: false, id: "a", file: "specs/a.spec.ts", line: 1, column: 1, tests: [] }] }] };
    const second: Readonly<Record<string, unknown>> = { suites: [{ title: "s", specs: [{ title: "[qa:TC-7/REV-7/INST-7@api] second report", ok: false, id: "b", file: "specs/b.spec.ts", line: 2, column: 1, tests: [] }] }] };
    expect(specLocationsByEntryIdentity([first, second]).has("TC-7/REV-7/INST-7@api")).toBe(false);
  });

  it("attaches the joined location to the matching attempt row and to no other", () => {
    const model = buildProjectionModel({ ...base, artifacts: [gateArtifact, batchWithTaggedEntry], runnerReports: [runnerReport] });
    expect(model.attempts.find((row) => row.id === "E-1")?.location).toEqual({ file: "specs/checkout.spec.ts", line: 42 });
    expect(model.attempts.find((row) => row.id === "E-2")?.location).toBeUndefined();
  });

  it("attaches no location at all when the reports were never passed in", () => {
    const model = buildProjectionModel({ ...base, artifacts: [gateArtifact, batchWithTaggedEntry], runnerReports: [] });
    expect(model.attempts.find((row) => row.id === "E-1")?.location).toBeUndefined();
  });

  it("never attaches a location to a lane-1 (driven) row, even when a report tags its identity", () => {
    // `runnerReport` tags TC-1/REV-1/INST-1@api; `drivenAttempt` carries the SAME testCaseId/revision/
    // instance but on lane 1, whose Execution Surface is always hardcoded "browser" -- never "api". A
    // driven attempt has no spec file at all, and the surface mismatch alone would already stop the
    // join; this proves the row still carries no `location` key.
    const model = buildProjectionModel({ ...base, artifacts: [gateArtifact, drivenAttempt], runnerReports: [runnerReport] });
    const row = model.attempts.find((candidate) => candidate.id === "ATT-1");
    expect(row).toBeDefined();
    expect(row?.location).toBeUndefined();
  });
});
