import { describe, expect, it } from "vitest";

import { QaSkillsError } from "../../src/core/errors.js";
import { mapObservedReport, observedEntrySurfaces, type RegisteredCase } from "../../src/observed/report-mapping.js";

/**
 * The lane-2 producer's identity and status mapping (Task 39b), tested as a pure function over a
 * Playwright JSON report so every branch is reachable without a real runner.
 *
 * Two decisions are pinned here rather than described anywhere else in code:
 * identity comes from an in-spec tag (`[qa:<caseId>/<revisionId>/<instanceId>@<surface>]`), and a
 * runner reports failure but never a cause (CONTEXT.md:43-45).
 */

const registered: RegisteredCase[] = [{ testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1" }];

type ResultInput = { status: string; duration?: number; retry?: number };

function result(input: ResultInput): Record<string, unknown> {
  return { status: input.status, duration: input.duration ?? 12, retry: input.retry ?? 0, startTime: "2026-07-28T00:00:00.000Z", workerIndex: 0, parallelIndex: 0, errors: [], stdout: [], stderr: [], annotations: [], attachments: [] };
}

function spec(title: string, results: readonly ResultInput[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title, ok: true, tags: [], id: "0123456789abcdef0123-fedcba9876543210fedc", file: "specs/observed.spec.js", line: 2, column: 5,
    tests: [{ timeout: 30000, annotations: [], expectedStatus: "passed", projectId: "", projectName: "", status: "expected", results: results.map(result) }],
    ...overrides,
  };
}

function report(specs: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { config: { version: "1.61.1", projects: [] }, suites: [{ title: "observed.spec.js", file: "specs/observed.spec.js", line: 0, column: 0, specs }], errors: [], stats: { expected: 1 } };
}

const tagged = (surface: string) => `checks the ledger [qa:TC-1/REV-1/INST-1@${surface}]`;

function refusalOf(call: () => unknown): QaSkillsError {
  try {
    call();
  } catch (error: unknown) {
    if (error instanceof QaSkillsError) return error;
    throw error;
  }
  throw new Error("expected a refusal, but the call returned");
}

describe("mapObservedReport identity", () => {
  it("binds one entry to the registered case named by the spec's own tag", () => {
    const mapped = mapObservedReport(report([spec(tagged("api"), [{ status: "passed" }])]), registered);

    expect(mapped.excluded).toEqual([]);
    expect(mapped.entries).toEqual([{
      entryId: "0123456789abcdef0123-fedcba9876543210fedc-0",
      testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1",
      status: "PASSED", failureClassification: "NONE", executionSurface: "api",
      steps: [{ stepId: "result-0", status: "PASSED", durationMs: 12 }],
    }]);
  });

  it("walks nested describe suites rather than only the file's top level", () => {
    const nested = { config: {}, suites: [{ title: "observed.spec.js", specs: [], suites: [{ title: "ledger", specs: [spec(tagged("api"), [{ status: "passed" }])] }] }], stats: {} };

    expect(mapObservedReport(nested, registered).entries).toHaveLength(1);
  });

  it("emits one entry per project run of the same spec, with distinct entry IDs", () => {
    const twoProjects = spec(tagged("api"), [{ status: "passed" }], {
      tests: [
        { projectId: "alpha", projectName: "alpha", status: "expected", results: [result({ status: "passed" })] },
        { projectId: "beta", projectName: "beta", status: "unexpected", results: [result({ status: "failed" })] },
      ],
    });
    const mapped = mapObservedReport(report([twoProjects]), registered);

    expect(mapped.entries.map((entry) => entry.entryId)).toEqual(["0123456789abcdef0123-fedcba9876543210fedc-0", "0123456789abcdef0123-fedcba9876543210fedc-1"]);
    expect(mapped.entries.map((entry) => entry.status)).toEqual(["PASSED", "FAILED"]);
  });

  it("excludes an untagged spec and says so, rather than dropping it silently", () => {
    const mapped = mapObservedReport(report([spec("checks the ledger", [{ status: "passed" }])]), registered);

    expect(mapped.entries).toEqual([]);
    expect(mapped.excluded).toEqual([{ entryId: "0123456789abcdef0123-fedcba9876543210fedc-0", title: "checks the ledger", file: "specs/observed.spec.js", reason: "no [qa:<testCaseId>/<revisionId>/<instanceId>@<surface>] tag in the test title" }]);
  });

  it("excludes a tagged spec whose identity matches no registered test case, and names the identity", () => {
    const mapped = mapObservedReport(report([spec("checks [qa:TC-9/REV-1/INST-1@api]", [{ status: "passed" }])]), registered);

    expect(mapped.entries).toEqual([]);
    expect(mapped.excluded[0]?.reason).toContain("TC-9/REV-1/INST-1");
    expect(mapped.excluded[0]?.reason).toContain("no registered test case");
  });

  it("refuses a tag matching more than one registered test case instead of picking one", () => {
    const duplicated = [...registered, { testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1" }];

    const refusal = refusalOf(() => mapObservedReport(report([spec(tagged("api"), [{ status: "passed" }])]), duplicated));

    expect(refusal.code).toBe("OBSERVED_SPEC_CASE_AMBIGUOUS");
    expect(refusal.message).toContain("TC-1/REV-1/INST-1");
  });

  it("refuses a title carrying two identity tags rather than reading the first", () => {
    const refusal = refusalOf(() => mapObservedReport(report([spec(`${tagged("api")} [qa:TC-1/REV-1/INST-1@unit]`, [{ status: "passed" }])]), registered));

    expect(refusal.code).toBe("OBSERVED_SPEC_TAG_INVALID");
    expect(refusal.message).toContain("two");
  });

  it("refuses a malformed tag rather than treating it as untagged", () => {
    const refusal = refusalOf(() => mapObservedReport(report([spec("checks [qa:TC-1/REV-1@api]", [{ status: "passed" }])]), registered));

    expect(refusal.code).toBe("OBSERVED_SPEC_TAG_INVALID");
  });

  it("refuses a surface the batch contract does not carry, naming the one that was written", () => {
    const refusal = refusalOf(() => mapObservedReport(report([spec(tagged("mobile"), [{ status: "passed" }])]), registered));

    expect(refusal.code).toBe("OBSERVED_SPEC_TAG_INVALID");
    expect(refusal.message).toContain("mobile");
    expect(refusal.message).toContain(observedEntrySurfaces.join(", "));
  });

  it("refuses `manual`, which a machine-run spec cannot honestly claim", () => {
    const refusal = refusalOf(() => mapObservedReport(report([spec(tagged("manual"), [{ status: "passed" }])]), registered));

    expect(refusal.code).toBe("OBSERVED_SPEC_TAG_INVALID");
  });

  it("refuses `browser` with a message that sends the caller to lane 1", () => {
    const refusal = refusalOf(() => mapObservedReport(report([spec(tagged("browser"), [{ status: "passed" }])]), registered));

    expect(refusal.code).toBe("OBSERVED_SPEC_SURFACE_UNSUPPORTED");
    expect(refusal.message).toContain("execute-browser-test");
    expect(refusal.message).toMatch(/engine|viewport/);
  });
});

describe("mapObservedReport status", () => {
  it.each([
    ["passed", "PASSED", "NONE"],
    ["failed", "FAILED", "UNDETERMINED"],
    ["timedOut", "FAILED", "UNDETERMINED"],
    ["skipped", "NOT_RUN", "UNDETERMINED"],
    ["interrupted", "BLOCKED", "UNDETERMINED"],
  ])("maps a %s result to %s / %s", (runnerStatus, status, failureClassification) => {
    const mapped = mapObservedReport(report([spec(tagged("api"), [{ status: runnerStatus }])]), registered);

    expect(mapped.entries[0]).toMatchObject({ status, failureClassification });
  });

  it("never diagnoses a cause: no mapping produces PRODUCT_DEFECT or TEST_DEFECT", () => {
    const every = ["passed", "failed", "timedOut", "skipped", "interrupted"].map((status) => spec(tagged("api"), [{ status }]));
    const classifications = mapObservedReport(report(every), registered).entries.map((entry) => entry.failureClassification);

    expect(classifications).not.toContain("PRODUCT_DEFECT");
    expect(classifications).not.toContain("TEST_DEFECT");
  });

  it("takes the entry status from the last retry and keeps every retry as a step", () => {
    const mapped = mapObservedReport(report([spec(tagged("api"), [{ status: "failed", duration: 5, retry: 0 }, { status: "passed", duration: 7, retry: 1 }])]), registered);

    expect(mapped.entries[0]?.status).toBe("PASSED");
    expect(mapped.entries[0]?.steps).toEqual([
      { stepId: "result-0", status: "FAILED", durationMs: 5 },
      { stepId: "result-1", status: "PASSED", durationMs: 7 },
    ]);
  });

  it("reads the runner's own per-execution status, not its expectedStatus verdict", () => {
    const expectedToFail = spec(tagged("api"), [], {
      tests: [{ expectedStatus: "failed", status: "expected", projectId: "", results: [result({ status: "failed" })] }],
    });

    expect(mapObservedReport(report([expectedToFail]), registered).entries[0]?.status).toBe("FAILED");
  });

  it("refuses a result status this runtime cannot classify rather than guessing one", () => {
    const refusal = refusalOf(() => mapObservedReport(report([spec(tagged("api"), [{ status: "quarantined" }])]), registered));

    expect(refusal.code).toBe("OBSERVED_RESULT_STATUS_UNRECOGNIZED");
    expect(refusal.message).toContain("quarantined");
  });

  it("refuses a test the runner reported no result for", () => {
    const refusal = refusalOf(() => mapObservedReport(report([spec(tagged("api"), [])]), registered));

    expect(refusal.code).toBe("OBSERVED_RESULT_STATUS_UNRECOGNIZED");
  });

  it.each([["missing", undefined], ["negative", -3], ["not finite", Number.NaN]])("floors a %s duration at the contract's minimum rather than failing registration", (_label, duration) => {
    const withoutDuration = spec(tagged("api"), [], { tests: [{ projectId: "", status: "expected", results: [{ status: "passed", ...(duration === undefined ? {} : { duration }) }] }] });

    expect(mapObservedReport(report([withoutDuration]), registered).entries[0]?.steps).toEqual([{ stepId: "result-0", status: "PASSED", durationMs: 0 }]);
  });

  it("treats a report with no suites as a clean empty mapping rather than an error", () => {
    expect(mapObservedReport({ config: {}, stats: {} }, registered)).toEqual({ entries: [], excluded: [] });
  });
});
