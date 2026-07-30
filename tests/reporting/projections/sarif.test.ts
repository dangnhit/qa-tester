import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { renderSarif } from "../../../src/reporting/projections/sarif.js";
import type { ProjectionModel } from "../../../src/reporting/projections/projection-model.js";

// The shared catalog instance is Ajv2020 with strict:true (src/contracts/catalog.ts:71). The SARIF
// schema is draft-07 (verified: fixtures/sarif/sarif-2.1.0-schema.json's own "$schema" is
// "http://json-schema.org/draft-07/schema#"), so this test builds its own plain Ajv rather than
// reconfiguring the catalog.
const require = createRequire(import.meta.url);
const Ajv = (require("ajv") as { default: new (options: object) => { compile: (schema: object) => (data: unknown) => boolean } }).default;
const addFormats = (require("ajv-formats") as { default: (instance: unknown) => void }).default;

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
const parseSarif = (json: string): SarifDoc => JSON.parse(json) as SarifDoc;

describe("renderSarif", () => {
  it("validates against the official SARIF 2.1.0 schema", async () => {
    const schema: object = JSON.parse(await readFile(new URL("../../../fixtures/sarif/sarif-2.1.0-schema.json", import.meta.url), "utf8"));
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    expect(ajv.compile(schema)(JSON.parse(renderSarif(model({
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
    }))))).toBe(true);
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
});
