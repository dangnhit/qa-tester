import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { renderSarif, type SarifProjection } from "../../../src/reporting/projections/sarif.js";
import type { AttemptRow, ProjectionModel } from "../../../src/reporting/projections/projection-model.js";

// The shared catalog instance is Ajv2020 with strict:true (src/contracts/catalog.ts:71). The SARIF
// schema is draft-07 (verified: fixtures/sarif/sarif-2.1.0-schema.json's own "$schema" is
// "http://json-schema.org/draft-07/schema#"), so this test builds its own plain Ajv rather than
// reconfiguring the catalog.
const require = createRequire(import.meta.url);
const Ajv = (require("ajv") as { default: new (options: object) => { compile: (schema: object) => (data: unknown) => boolean } }).default;
const addFormats = (require("ajv-formats") as { default: (instance: unknown) => void }).default;

/**
 * The OFFICIAL SARIF 2.1.0 schema, compiled from the vendored copy — the only check in this file that
 * sees what GitHub's code-scanning upload sees. Extracted from the single test that used to own it
 * because more than one behaviour now has to be measured through it, and a `toContain` on an expected
 * string would be exactly the check that cannot see the real consumer.
 */
const compileSarifSchema = async (): Promise<(document: unknown) => boolean> => {
  const schema: object = JSON.parse(await readFile(new URL("../../../fixtures/sarif/sarif-2.1.0-schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
};

/** One observed FAILED row carrying `file` as its spec location: the only shape in the whole model that
 *  reaches `artifactLocation.uri`. */
const rowLocatedAt = (file: string): AttemptRow => ({
  lane: "observed-entry", id: "E-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1",
  status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "api", durationMs: 5,
  provenance: "runtime-observed", location: { file },
});

const model = (over: Partial<ProjectionModel> = {}): ProjectionModel => ({
  runId: "RUN-1", producerVersion: "0.3.0", generatedAt: "2026-07-29T00:00:00.000Z", reduced: false,
  gate: { artifactId: "gate-1", sha256: "a".repeat(64), recommendation: "NOT_READY", verdicts: [
    { rule: "VALID_ARTIFACTS", passed: true, reason: "All registered artifacts are valid." },
    { rule: "REQUIRED_COVERAGE_COMPLETE", passed: false, reason: "Required coverage missing: COV-1." },
  ] },
  attempts: [], findings: [], sourceArtifacts: [], ...over,
});

// Minimal shape of the parsed SARIF document this test file actually reads, so `JSON.parse(...)` results
// carry a real type instead of `any` (the project's ESLint config only relaxes `no-unsafe-assignment` for
// tests, not `no-unsafe-call`/`no-unsafe-member-access` — the same idiom as
// `tests/reporting/protected-environment-label.test.ts`'s `JSON.parse(...) as { ... }`).
type SarifResult = {
  ruleId: string;
  level: string;
  message: { text: string };
  locations?: { physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } } }[];
};
type SarifDoc = {
  runs: [{
    automationDetails: { id: string };
    versionControlProvenance?: { repositoryUri: string; revisionId: string }[];
    properties?: { commitSha: string; specTreeSha256: string };
    results: SarifResult[];
  }];
};
/** Takes the whole `SarifProjection` rather than its `document`, so every case below reads
 *  `parseSarif(renderSarif(...))` unchanged and only the cases that care about the count name it. */
const parseSarif = (rendered: SarifProjection): SarifDoc => JSON.parse(rendered.document) as SarifDoc;

describe("renderSarif", () => {
  it("validates against the official SARIF 2.1.0 schema", async () => {
    expect((await compileSarifSchema())(JSON.parse(renderSarif(model({
      // Two open bugs sharing "open-bug" as their ruleId (an ordinary run shape: more than one open bug
      // is common) make `tool.driver.rules`'s de-duplication LOAD-BEARING for this test: the schema's
      // `reportingDescriptor` array has `uniqueItems: true`, so two identical `{ "id": "open-bug" }`
      // entries would fail validation if the renderer's `[...new Set(...)]` were ever deleted.
      findings: [
        { ruleId: "open-bug", level: "error", id: "BUG-1", message: "open bug BUG-1, severity Critical" },
        { ruleId: "open-bug", level: "warning", id: "BUG-3", message: "open bug BUG-3, severity Minor" },
      ],
      attempts: [{ lane: "observed-entry", id: "E-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1", status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "api", durationMs: 5, provenance: "runtime-observed", location: { file: "specs/checkout.spec.ts", line: 42 } }],
      anchor: { commitSha: "d".repeat(40), specTreeSha256: "e".repeat(64) },
    })).document))).toBe(true);
  });

  /**
   * A spec filename is authored by whoever wrote the spec, and nothing between the filesystem and this
   * renderer constrains its characters. Measured against the vendored official schema with this file's
   * own ajv: `e2e/check out.spec.ts`, `e2e/テスト.spec.ts` and `e2e/100%-done.spec.ts` each failed
   * `artifactLocation.uri`'s `format: "uri-reference"` when copied across verbatim — and the failure
   * lands OUTSIDE this repo, at GitHub's upload, where the WHOLE projection is rejected over one
   * filename while `qa-skill export` exits 0 and the sidecar certifies the rejected bytes. Same failure
   * class as the `region.startLine` guard one field over.
   *
   * Measured through the schema rather than asserted against an expected string on purpose: a
   * `toContain("%20")` cannot see what the real consumer sees, which is the mistake this branch's
   * finding I4 already was.
   */
  it.each([
    ["a space", "e2e/check out.spec.ts"],
    ["a non-ASCII character", "e2e/テスト.spec.ts"],
    ["a literal percent sign", "e2e/100%-done.spec.ts"],
    ["a bracket", "e2e/a[1].spec.ts"],
  ])("still validates against the official schema when a spec filename carries %s", async (_case, file) => {
    expect((await compileSarifSchema())(JSON.parse(renderSarif(model({ attempts: [rowLocatedAt(file)] })).document))).toBe(true);
  });

  /**
   * The half the schema CANNOT catch, which is why it needs a test of its own rather than another ajv
   * row: `e2e/a#b.spec.ts` and `e2e/a?b.spec.ts` are both perfectly valid `uri-reference`s — measured
   * `valid: true` against the vendored schema — and both name the WRONG FILE. A `#` opens a fragment,
   * so that URI names `e2e/a` with fragment `b.spec.ts`; a `?` opens a query the same way. A wrong
   * location is worse than none, because a reader cannot tell it from a right one.
   *
   * Read the way a consumer reads it — resolved against a repository base with the platform URL
   * parser — rather than compared against a hand-written encoded literal. That pins all three things
   * at once and nothing else does: no fragment or query was opened, every segment decodes back to the
   * authored filename, and `/` SURVIVED as the separator (a whole-path `encodeURIComponent`, which
   * would escape it to `%2F`, collapses the segment count and fails here even though every character
   * still decodes correctly).
   */
  it.each([
    ["a fragment delimiter", "e2e/a#b.spec.ts"],
    ["a query delimiter", "e2e/a?b.spec.ts"],
    ["a literal percent sign, which must round-trip rather than double-encode", "e2e/100%-done.spec.ts"],
  ])("emits a uri naming the whole file, and only that file, when the filename carries %s", (_case, file) => {
    const sarif = parseSarif(renderSarif(model({ attempts: [rowLocatedAt(file)] })));
    // By ruleId, not `results[0]`: the base model already carries a failing gate verdict, which sorts
    // ahead of every observed failure and carries no location at all.
    const observed = sarif.runs[0].results.find((result) => result.ruleId === "observed-failure");
    const uri = observed?.locations?.[0]?.physicalLocation.artifactLocation.uri ?? "";

    const resolved = new URL(uri, "https://example.invalid/repo/");

    expect(resolved.hash).toBe("");
    expect(resolved.search).toBe("");
    expect(resolved.pathname.split("/").map(decodeURIComponent)).toEqual(["", "repo", ...file.split("/")]);
  });

  /**
   * TOTALITY: `renderSarif` always returns. `encodeURIComponent` throws `URIError` on an unpaired
   * UTF-16 surrogate, and before the fix one reached a real export without any filesystem being
   * involved — a sanitized runner report is registered BINARY content that nothing schema-validates,
   * `\ud800` is a LEGAL JSON escape, and `JSON.parse` restores it verbatim on every platform. Measured
   * end to end from the real read path, the throw surfaced through `program.ts`'s final `else` as the
   * bare string `URI malformed` at exit `ABORTED_OR_INTERNAL`, naming no spec file and no artifact — an
   * internal error where the truth is a data problem.
   *
   * With `spec-locations.ts` now refusing such a path, this branch is UNREACHABLE IN PRODUCTION AS
   * SHIPPED, and the test says so by building the model directly. That is not a reason to skip it: the
   * model is constructed here exactly as an in-repo caller could construct it, and this test is what
   * keeps the renderer total if the producer is ever weakened. It is NOT reachable from outside the
   * package — `exports` publishes only `.` and `./cli` — so "any caller" means an in-repo one.
   *
   * The location is OMITTED rather than neutralized to `�`, and that is not a disagreement with
   * `junit.ts`'s `escapeXml` — see `artifactUri`'s TSDoc for why one field is mandatory and the other
   * optional. The RESULT still has to survive: a location is an annotation on a result, never a gate on
   * whether it exists, so asserting only "does not throw" would let a renderer that silently dropped
   * the whole failure pass.
   */
  it("does not throw on a spec filename carrying a lone surrogate, and omits the location rather than naming a file that does not exist", () => {
    const render = (): SarifProjection => renderSarif(model({ attempts: [rowLocatedAt("e2e/bad\uD800name.spec.ts")] }));

    expect(render).not.toThrow();

    const observed = parseSarif(render()).runs[0].results.find((result) => result.ruleId === "observed-failure");
    expect(observed).toBeDefined();
    expect(observed?.locations).toBeUndefined();
  });

  /**
   * The same totality contract with the surrogate OFF THE LEAF. The test above cannot distinguish a
   * renderer that checks the whole path from one that checks only the last segment, because it puts the
   * surrogate in the last segment; `encodeURIComponent` throws on whichever segment holds it.
   */
  it("does not throw when the lone surrogate is in a directory segment rather than the filename", () => {
    const render = (): SarifProjection => renderSarif(model({ attempts: [rowLocatedAt("e2e/bad\uD800dir/name.spec.ts")] }));

    expect(render).not.toThrow();

    const observed = parseSarif(render()).runs[0].results.find((result) => result.ruleId === "observed-failure");
    expect(observed).toBeDefined();
    expect(observed?.locations).toBeUndefined();
  });

  it("emits one result per failing verdict and per finding, and none for a passing verdict", () => {
    const sarif = parseSarif(renderSarif(model({ findings: [{ ruleId: "open-bug", level: "warning", id: "BUG-2", message: "open bug BUG-2, severity Minor" }] })));
    expect(sarif.runs[0].results.map((result) => [result.ruleId, result.level]))
      .toEqual([["REQUIRED_COVERAGE_COMPLETE", "error"], ["open-bug", "warning"]]);
  });

  it("attaches a location only to an observed failure that has one, and never invents one", () => {
    const sarif = parseSarif(renderSarif(model({
      attempts: [
        { lane: "observed-entry", id: "E-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1", status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "api", durationMs: 5, provenance: "runtime-observed", location: { file: "specs/checkout.spec.ts", line: 42 } },
        { lane: "observed-entry", id: "E-2", testCaseId: "TC-2", testCaseRevisionId: "REV-2", testCaseInstanceId: "INST-2", status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "unit", durationMs: 5, provenance: "runtime-observed" },
        { lane: "observed-entry", id: "E-3", testCaseId: "TC-3", testCaseRevisionId: "REV-3", testCaseInstanceId: "INST-3", status: "PASSED", failureClassification: "NONE", executionSurface: "unit", durationMs: 5, provenance: "runtime-observed" },
        // `ProjectionLocation.line` is optional (`file` alone is a valid join) — a location present
        // without a line number must still omit `region` rather than invent a line, the same "no
        // invented value" rule as an entirely absent location. Without this row, `line === undefined`'s
        // branch inside the location ternary has no test and no mutation, the exact defect class Task
        // 2's review caught in `projection-model.ts`'s severity branch.
        { lane: "observed-entry", id: "E-4", testCaseId: "TC-4", testCaseRevisionId: "REV-4", testCaseInstanceId: "INST-4", status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "unit", durationMs: 5, provenance: "runtime-observed", location: { file: "specs/no-line.spec.ts" } },
      ],
    })));
    const observed = sarif.runs[0].results.filter((result) => result.ruleId === "observed-failure");
    expect(observed).toHaveLength(3);
    expect(observed[0]?.locations?.[0]?.physicalLocation).toEqual({ artifactLocation: { uri: "specs/checkout.spec.ts" }, region: { startLine: 42 } });
    expect(observed[1]?.locations).toBeUndefined();
    expect(observed[2]?.locations?.[0]?.physicalLocation).toEqual({ artifactLocation: { uri: "specs/no-line.spec.ts" } });
  });

  /**
   * The COUNT, over BOTH reasons a result carries no location, because the renderer treats them as one
   * claim — "this run cannot say where" — and `observedResult`'s TSDoc says they are deliberately
   * indistinguishable in the output. E-2 has no `location` on the model at all; E-4's location is a path
   * no URI can spell, which is invisible on the model and visible only after `artifactUri` has answered.
   * A count derived from `model.attempts` instead of from the rendered results would say 1 here.
   *
   * The located row and the PASSED row hold the denominator honest, and the base model's failing gate
   * verdict is the third: it is a result with no location and must NOT be counted, because a gate rule is
   * not a file position that failed to resolve.
   */
  it("counts every observed failure it emitted without a location, whichever of the two reasons applied", () => {
    const rendered = renderSarif(model({
      findings: [{ ruleId: "open-bug", level: "warning", id: "BUG-2", message: "open bug BUG-2, severity Minor" }],
      attempts: [
        { lane: "observed-entry", id: "E-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1", status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "api", durationMs: 5, provenance: "runtime-observed", location: { file: "specs/checkout.spec.ts", line: 42 } },
        { lane: "observed-entry", id: "E-2", testCaseId: "TC-2", testCaseRevisionId: "REV-2", testCaseInstanceId: "INST-2", status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "unit", durationMs: 5, provenance: "runtime-observed" },
        { lane: "observed-entry", id: "E-3", testCaseId: "TC-3", testCaseRevisionId: "REV-3", testCaseInstanceId: "INST-3", status: "PASSED", failureClassification: "NONE", executionSurface: "unit", durationMs: 5, provenance: "runtime-observed" },
        rowLocatedAt("e2e/bad\uD800name.spec.ts"),
      ],
    }));

    expect(rendered.observedResultsWithoutLocation).toBe(2);
    // And the count agrees with the bytes it was reported alongside, which is the only thing that makes
    // it worth returning from here rather than deriving it somewhere else.
    expect(parseSarif(rendered).runs[0].results.filter((result) => result.ruleId === "observed-failure" && result.locations === undefined)).toHaveLength(2);
  });

  it("counts zero when every observed failure it emitted was placed", () => {
    expect(renderSarif(model({ attempts: [rowLocatedAt("e2e/checkout.spec.ts")] })).observedResultsWithoutLocation).toBe(0);
  });

  // Controller decision (not in the brief): a projection never filters on provenance
  // (generate-qa-report.ts:39-41), and an observed-failure result names the row's own provenance
  // unconditionally -- for a crediting lane value exactly as for a non-crediting one -- because a
  // message that names it only sometimes teaches a reader nothing when it is absent.
  it("names the attempt's own provenance in an observed-failure result's message, for every observed failure", () => {
    const sarif = parseSarif(renderSarif(model({
      attempts: [
        { lane: "observed-entry", id: "E-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1", status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "api", durationMs: 5, provenance: "runtime-observed" },
        { lane: "observed-entry", id: "E-2", testCaseId: "TC-2", testCaseRevisionId: "REV-2", testCaseInstanceId: "INST-2", status: "FAILED", failureClassification: "PRODUCT_DEFECT", executionSurface: "unit", durationMs: 5, provenance: "agent-draft" },
      ],
    })));
    const observed = sarif.runs[0].results.filter((result) => result.ruleId === "observed-failure");
    expect(observed[0]?.message.text).toContain("runtime-observed");
    expect(observed[1]?.message.text).toContain("agent-draft");
  });

  it("records the run id, and never invents a repository location the model does not carry", () => {
    // The SARIF schema requires `repositoryUri` (format: uri, non-empty) on every
    // `versionControlDetails` entry (fixtures/sarif/sarif-2.1.0-schema.json's
    // `definitions.versionControlDetails.required`) -- verified empirically: both
    // `repositoryUri: ""` (fails the "uri" format check) and dropping `repositoryUri` while keeping
    // only `revisionId` (fails "must have required property 'repositoryUri'") are schema-invalid.
    // `ProjectionModel` carries no repository URL anywhere -- not on `anchor`, not on a
    // `test-result-batch` artifact -- and this renderer is a pure function with no filesystem access
    // to discover one. Inventing a value (this tool's own repo, a "file:" placeholder, an empty
    // string) would misdescribe whichever repository a CI consumer is actually scanning, so
    // `versionControlProvenance` is never populated, anchor or no anchor.
    const withAnchor = parseSarif(renderSarif(model({ anchor: { commitSha: "d".repeat(40), specTreeSha256: "e".repeat(64) } })));
    expect(withAnchor.runs[0].automationDetails.id).toBe("RUN-1");
    expect(withAnchor.runs[0].versionControlProvenance).toBeUndefined();
    expect(parseSarif(renderSarif(model())).runs[0].versionControlProvenance).toBeUndefined();
  });

  // Human ruling (fix round 1): dropping the verified anchor entirely went one step further than the
  // schema finding justified. `commitSha`/`specTreeSha256` are facts the run VERIFIED (the lane-2 git
  // anchor, re-resolved after the runner exits, ADR-0010) -- not an invented `physicalLocation` -- so they
  // belong in `run.properties`, SARIF's sanctioned propertyBag (`additionalProperties: true`) for a
  // verified fact with no clean named field, rather than being thrown away with the field that DOES
  // require an unavailable `repositoryUri`.
  it("carries the verified git anchor in run.properties when one exists, and omits it when there is none", () => {
    const withAnchor = parseSarif(renderSarif(model({ anchor: { commitSha: "d".repeat(40), specTreeSha256: "e".repeat(64) } })));
    expect(withAnchor.runs[0].properties).toEqual({ commitSha: "d".repeat(40), specTreeSha256: "e".repeat(64) });
    expect(parseSarif(renderSarif(model())).runs[0].properties).toBeUndefined();
  });

  /**
   * `tool.driver.version` reads the version off the MODEL, not off the imported `runtimeVersion`. The
   * two are identical in production — `exportProjection` passes `runtimeVersion` in as
   * `producerVersion` — which is exactly what makes the difference untestable without a model whose
   * `producerVersion` is deliberately something else. The sidecar records `model.producerVersion` for
   * these same bytes, so a document sourcing it elsewhere is a surface on which the projection and the
   * sidecar that vouches for it can disagree.
   */
  it("names the model's own producerVersion, not a version read from anywhere else", () => {
    const sarif = JSON.parse(renderSarif(model({ producerVersion: "9.9.9-test" })).document) as { runs: [{ tool: { driver: { version: string } } }] };
    expect(sarif.runs[0].tool.driver.version).toBe("9.9.9-test");
  });
});
