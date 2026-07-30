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

  /**
   * SARIF's `region.startLine` is `{"type": "integer", "minimum": 1}` — verified in the vendored
   * official schema (`fixtures/sarif/sarif-2.1.0-schema.json`), not assumed. A payload carrying `line:
   * 0` or `line: 1.5` would therefore render a document that fails validation at GitHub's upload, which
   * is the failure the vendored-schema decision exists to prevent. This payload is the CONTENT of a
   * binary, so no schema has vetted it before it reaches here.
   *
   * The location survives WITHOUT the line rather than being dropped: the file is still a true location
   * and still points a reader at the right spec. Dropping it would discard a fact that is correct
   * because a neighbouring one is not.
   */
  it.each([[0, "zero"], [-3, "negative"], [1.5, "fractional"], [Number.NaN, "NaN"], [Number.POSITIVE_INFINITY, "infinite"]])(
    "keeps the file but drops a %s line, which SARIF's startLine cannot carry", (line) => {
      const report: Readonly<Record<string, unknown>> = { suites: [{ title: "s", specs: [{ title: "[qa:TC-L/REV-L/INST-L@api] bad line", ok: false, id: "spec-l", file: "specs/bad-line.spec.ts", line, column: 1, tests: [] }] }] };
      expect(specLocationsByEntryIdentity([report]).get("TC-L/REV-L/INST-L@api")).toEqual({ file: "specs/bad-line.spec.ts" });
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

  /**
   * The discriminating case the two tests above cannot reach, because both use DIFFERENT files.
   *
   * A run may hold several Runtime-Observed Executions — `executeObservedPlaywright` mints a fresh
   * `executionId` per invocation with no uniqueness guard, and `tests/operations/export-projection.test.ts`
   * registers two — so re-executing the same observed suite (a retry, or a second pass after a fix)
   * hands this function two sanitized reports over the same spec tree. Every identity in them agrees
   * with itself, byte for byte. Under a has-key ambiguity test that emptied the ENTIRE map:
   * `unreadableRunnerReports` stayed empty, the export exited 0, and the SARIF was indistinguishable
   * from a run whose specs were never tagged. Ambiguity is a DISAGREEMENT, and two reports saying the
   * same thing disagree about nothing.
   */
  it("keeps a location claimed twice at the SAME file and line, because agreement is not ambiguity", () => {
    const spec = { title: "[qa:TC-8/REV-8/INST-8@api] retried", ok: false, id: "spec-8", file: "specs/retried.spec.ts", line: 12, column: 1, tests: [] };
    const report: Readonly<Record<string, unknown>> = { suites: [{ title: "s", specs: [spec] }] };

    const joined = specLocationsByEntryIdentity([report, report]);

    expect(joined.get("TC-8/REV-8/INST-8@api")).toEqual({ file: "specs/retried.spec.ts", line: 12 });
    expect(joined.size).toBe(1);
  });

  /**
   * The same agreement, reached through the LINE guard rather than through equal payloads: `line: 0`
   * and an absent `line` both resolve to no line, so the two locations this function would emit are
   * equal even though the payload fields are not. Comparing raw payload fields instead of resolved
   * locations would call this a conflict and drop a location both reports agree on.
   */
  it("treats a rejected line and an absent line as agreeing, because both resolve to no line", () => {
    const withZero: Readonly<Record<string, unknown>> = { suites: [{ title: "s", specs: [{ title: "[qa:TC-8/REV-8/INST-8@api] a", ok: false, id: "a", file: "specs/same.spec.ts", line: 0, column: 1, tests: [] }] }] };
    const withNone: Readonly<Record<string, unknown>> = { suites: [{ title: "s", specs: [{ title: "[qa:TC-8/REV-8/INST-8@api] b", ok: false, id: "b", file: "specs/same.spec.ts", column: 1, tests: [] }] }] };

    expect(specLocationsByEntryIdentity([withZero, withNone]).get("TC-8/REV-8/INST-8@api")).toEqual({ file: "specs/same.spec.ts" });
  });

  it("attaches the joined location to the matching attempt row and to no other", () => {
    const model = buildProjectionModel({ ...base, artifacts: [gateArtifact, batchWithTaggedEntry], runnerReports: [runnerReport] });
    expect(model.attempts.find((row) => row.id === "E-1")?.location).toEqual({ file: "specs/checkout.spec.ts", line: 42 });
    expect(model.attempts.find((row) => row.id === "E-2")?.location).toBeUndefined();
  });

  /**
   * The ruling in `buildProjectionModel`'s location comment, pinned. Reduction strips AUTHORED TEXT; a
   * spec path is committed spec-tree content, covered by the `specTreeSha256`/`commitSha` anchor the
   * reduced model still carries, so it is not the class of thing reduction exists to remove. Asserted
   * alongside the reduction that IS applied to the same model, so a future change that started
   * stripping locations could not pass by also breaking reduction.
   */
  it("keeps a joined location under reduction, where authored text is stripped", () => {
    const protectedGate: ProjectionArtifact = {
      ...gateArtifact,
      value: {
        ...gateArtifact.value, protectedEnvironment: true,
        ruleInputs: { artifactsValid: true, coverage: { requiredMissing: [], optionalGaps: [], requiredHighRisk: [] }, bugs: [], sharedBlockers: ["Evidence gap GAP-1 affects the checkout total shown to a signed-in buyer"] },
        verdicts: [{ rule: "NO_SHARED_BLOCKERS", passed: false, reason: "Shared blockers: Evidence gap GAP-1 affects the checkout total shown to a signed-in buyer." }],
      },
    };
    const model = buildProjectionModel({ ...base, artifacts: [protectedGate, batchWithTaggedEntry], runnerReports: [runnerReport] });
    expect(model.reduced).toBe(true);
    expect(model.attempts.find((row) => row.id === "E-1")?.location).toEqual({ file: "specs/checkout.spec.ts", line: 42 });
    expect(JSON.stringify(model)).not.toContain("checkout total shown to a signed-in buyer");
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
