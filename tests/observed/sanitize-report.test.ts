import { describe, expect, it } from "vitest";

import { removedRunnerReportFields, runnerReportSanitizationPolicy, sanitizeRunnerReport } from "../../src/observed/sanitize-report.js";

/**
 * The payload lane 2 registers as **Sanitized Raw Evidence** (CONTEXT.md:275-277: "captured after
 * mandatory redaction but before annotation or presentation overlays").
 *
 * The report file the runner leaves on disk is NOT what gets registered, and this suite is where that
 * is proven: an allowlist at every nesting level, and one row per disclosed removal so the descriptor's
 * own claim about what it dropped is a tested claim rather than a sentence.
 */

const secret = "sk-live-abcdef0123456789";

/** A report carrying a secret in every place the reporter can put caller-controlled bytes. Built from
 *  `JSONReporter._serializeReport`'s real field names, so a field the reporter emits and this suite
 *  forgot would show up as an unexpected key in the passthrough assertions below. */
function hostileReport(): Record<string, unknown> {
  return {
    config: {
      version: "1.61.1", rootDir: "/srv/app/specs", configFile: "/srv/app/playwright.config.ts", workers: 4, shard: null,
      argv: ["node", "cli.js", "test", secret], metadata: { deployToken: secret }, webServer: { command: "npm start", env: { API_TOKEN: secret } },
      projects: [{ id: "api", name: "api", testDir: "/srv/app/specs", timeout: 30000, repeatEach: 1, retries: 0, outputDir: "/tmp/qa-skills-observed-x/artifacts", metadata: { token: secret } }],
    },
    errors: [{ message: `config failed: ${secret}`, stack: secret }],
    stats: { startTime: "2026-07-28T00:00:00.000Z", duration: 1300.9, expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
    suites: [{
      title: "observed.spec.js", file: "specs/observed.spec.js", line: 0, column: 0,
      specs: [{
        title: "checks the ledger [qa:TC-1/REV-1/INST-1@api]", ok: false, id: "abc-def", file: "specs/observed.spec.js", line: 2, column: 5,
        tags: [secret],
        tests: [{
          timeout: 30000, expectedStatus: "passed", projectId: "api", projectName: "api", status: "unexpected",
          annotations: [{ type: "issue", description: secret }],
          results: [{
            workerIndex: 0, parallelIndex: 0, status: "failed", duration: 12, retry: 0, startTime: "2026-07-28T00:00:00.000Z",
            error: { message: secret }, errors: [{ message: secret }], errorLocation: { file: secret, line: 1, column: 1 },
            stdout: [{ text: secret }], stderr: [{ buffer: Buffer.from(secret).toString("base64") }],
            annotations: [{ type: "note", description: secret }],
            attachments: [{ name: "screenshot", contentType: "image/png", path: `/tmp/${secret}.png`, body: Buffer.from(secret).toString("base64") }],
            steps: [{ title: `log in with ${secret}`, duration: 3 }],
          }],
        }],
      }],
    }],
  };
}

describe("sanitizeRunnerReport", () => {
  it("keeps exactly the observation fields lane 2 registers, at every nesting level", () => {
    const payload = sanitizeRunnerReport(hostileReport());

    expect(Object.keys(payload).sort()).toEqual(["config", "sanitization", "stats", "suites"]);
    expect(payload.config).toEqual({
      version: "1.61.1", rootDir: "/srv/app/specs", configFile: "/srv/app/playwright.config.ts", workers: 4, shard: null,
      projects: [{ id: "api", name: "api", testDir: "/srv/app/specs", timeout: 30000, repeatEach: 1, retries: 0 }],
    });
    expect(payload.stats).toEqual({ startTime: "2026-07-28T00:00:00.000Z", duration: 1300.9, expected: 1, skipped: 0, unexpected: 0, flaky: 0 });
    expect(payload.suites).toEqual([{
      title: "observed.spec.js", file: "specs/observed.spec.js", line: 0, column: 0,
      specs: [{
        title: "checks the ledger [qa:TC-1/REV-1/INST-1@api]", ok: false, id: "abc-def", file: "specs/observed.spec.js", line: 2, column: 5,
        tests: [{
          timeout: 30000, expectedStatus: "passed", projectId: "api", projectName: "api", status: "unexpected",
          results: [{ workerIndex: 0, parallelIndex: 0, status: "failed", duration: 12, retry: 0, startTime: "2026-07-28T00:00:00.000Z" }],
        }],
      }],
    }]);
  });

  it("carries no resolved secret anywhere, from any of the places the reporter can put one", () => {
    expect(JSON.stringify(sanitizeRunnerReport(hostileReport()))).not.toContain(secret);
  });

  it.each(removedRunnerReportFields.map((field) => [field]))("discloses %s as removed, and it really is", (field) => {
    // The disclosure block NAMES every removed field, so searching the whole payload would find each
    // name in `sanitization.removed` and pass for the wrong reason. Only the observation survives here.
    const { sanitization, ...observation } = sanitizeRunnerReport(hostileReport());
    expect(sanitization).toBeDefined();
    const leaf = field.split(".").at(-1) ?? field;

    expect(JSON.stringify(observation)).not.toContain(`"${leaf}"`);
  });

  it("states the policy and the removals in the payload itself, since the evidence provenance branch has no field for them", () => {
    const payload = sanitizeRunnerReport(hostileReport());

    expect(payload.sanitization).toMatchObject({ policy: runnerReportSanitizationPolicy, removed: removedRunnerReportFields });
    expect((payload.sanitization as { note: string }).note).toMatch(/CONTEXT\.md:371|resolved secret/);
  });

  it("preserves nested describe suites rather than flattening or dropping them", () => {
    const nested = { suites: [{ title: "file", suites: [{ title: "ledger", specs: [{ title: "inner", id: "x", tests: [] }] }], specs: [] }] };

    expect(sanitizeRunnerReport(nested).suites).toEqual([{ title: "file", suites: [{ title: "ledger", specs: [{ title: "inner", id: "x", tests: [] }] }], specs: [] }]);
  });

  it("drops a config, suite, spec, test or result whose shape it does not recognise rather than passing it through", () => {
    const malformed = { config: "a string", stats: [1, 2], suites: ["not a suite", { title: "file", specs: ["not a spec", { title: "t", tests: ["not a test", { results: ["not a result"] }] }] }] };

    expect(sanitizeRunnerReport(malformed)).toEqual({
      sanitization: expect.anything() as unknown,
      suites: [{ title: "file", specs: [{ title: "t", tests: [{ results: [] }] }] }],
    });
  });

  it("omits a key the runner did not emit rather than writing an explicit null for it", () => {
    expect(sanitizeRunnerReport({ stats: { expected: 1 } })).toMatchObject({ stats: { expected: 1 } });
    expect(Object.keys((sanitizeRunnerReport({ stats: { expected: 1 } }).stats) as object)).toEqual(["expected"]);
  });
});
