import { array, isRecord } from "../core/values.js";

/** Versioned so a later change to this projection produces a visibly different disclosure rather than
 *  a silently different artifact. Registered payloads are immutable and checksummed; the policy label
 *  is what lets a reader of an old one know which rule produced it. */
export const runnerReportSanitizationPolicy = "qa-skills/observed-runner-report/v1" as const;

/**
 * Every field this projection removes, in the payload's own path notation, and the list the payload
 * discloses. Each row is exercised by `tests/observed/sanitize-report.test.ts`, which plants a resolved
 * secret at that exact path and asserts it does not survive — so the disclosure is a tested claim, not
 * a sentence next to the code.
 *
 * The line these rows draw is **committed spec-tree content versus run-time output**. A spec's `title`
 * survives, because it carries the identity tag, is covered by the batch's own `specTreeSha256`, and was
 * reviewed by whoever merged it. Everything below is produced WHILE the suite runs — where a resolved
 * secret appears (CONTEXT.md:371) and where no review ever looked. There is no honest middle course:
 * redaction (`src/evidence/redaction.ts`) needs the resolved secret values to scrub, and this producer
 * never learns them — lane 2's secrets belong to the external suite's own process.
 *
 * **The cost is real and is not hidden: a registered payload does not say WHY a test failed.** The
 * failure text, the error stack, the attachments and the captured stdio all go. What survives is what a
 * Coverage Obligation is credited from — which spec ran, under which project, with which status, at
 * which retry. The runner's verbatim report is still on disk in the runtime's temp working directory
 * for an operator to read; it is simply never registered, because an immutable checksummed artifact is
 * the worst possible place to discover a token.
 */
export const removedRunnerReportFields: readonly string[] = [
  "config.argv",
  "config.metadata",
  "config.webServer",
  "config.projects[].metadata",
  "config.projects[].outputDir",
  "errors",
  "suites[].specs[].tags",
  "suites[].specs[].tests[].annotations",
  "suites[].specs[].tests[].results[].error",
  "suites[].specs[].tests[].results[].errors",
  "suites[].specs[].tests[].results[].errorLocation",
  "suites[].specs[].tests[].results[].stdout",
  "suites[].specs[].tests[].results[].stderr",
  "suites[].specs[].tests[].results[].annotations",
  "suites[].specs[].tests[].results[].attachments",
  "suites[].specs[].tests[].results[].steps",
];

const sanitizationNote =
  "This payload is Sanitized Raw Evidence (CONTEXT.md:275-277), not the runner's report file. The fields listed in `removed` are stripped "
  + "because they carry run-time output rather than reviewed spec-tree content, and CONTEXT.md:371 forbids a resolved secret value in an artifact. "
  + "`sha256` on the evidence descriptor is the checksum of THIS payload, so what was registered is what was hashed.";

/** `config` keys kept. DELIBERATELY its own allowlist and a strict subset of the one
 *  `src/observed/run-playwright.ts` already applied: this function must be safe on a report that did
 *  not come through that boundary, and a second narrower list means a widening there cannot widen this.
 *  `outputDir` is dropped because it names the runtime's temp working directory, which an immutable
 *  artifact cannot resolve later and which is misleading to record as if it could. */
const configKeys = ["version", "rootDir", "configFile", "workers", "shard"] as const;
const projectKeys = ["id", "name", "testDir", "timeout", "repeatEach", "retries"] as const;
const statsKeys = ["startTime", "duration", "expected", "skipped", "unexpected", "flaky"] as const;
const suiteKeys = ["title", "file", "line", "column"] as const;
const specKeys = ["title", "ok", "id", "file", "line", "column"] as const;
const testKeys = ["timeout", "expectedStatus", "projectId", "projectName", "status"] as const;
const resultKeys = ["workerIndex", "parallelIndex", "status", "duration", "retry", "startTime"] as const;

/** Copies only the named keys that are present, so a key the runner did not emit stays absent rather
 *  than becoming an explicit `undefined` a reader would have to distinguish. Same shape as
 *  `run-playwright.ts`'s `pick`, and deliberately re-stated here rather than imported: this module must
 *  not depend on the spawn primitive to be safe. */
function pick(source: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
}

/** Projects each element the projection recognises and DROPS every element it does not. Fail closed:
 *  an array member that is not an object cannot be projected key by key, and passing it through whole
 *  is the one hole an allowlist cannot afford. */
function projectEach(value: unknown, project: (item: Readonly<Record<string, unknown>>) => Record<string, unknown>): Record<string, unknown>[] {
  return array(value).flatMap((item) => isRecord(item) ? [project(item)] : []);
}

function projectResult(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return pick(result, resultKeys);
}

function projectTest(test: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...pick(test, testKeys), results: projectEach(test.results, projectResult) };
}

function projectSpec(spec: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...pick(spec, specKeys), tests: projectEach(spec.tests, projectTest) };
}

function projectSuite(suite: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    ...pick(suite, suiteKeys),
    ...("suites" in suite ? { suites: projectEach(suite.suites, projectSuite) } : {}),
    ...("specs" in suite ? { specs: projectEach(suite.specs, projectSpec) } : {}),
  };
}

/**
 * Turns one observed Playwright report into the payload lane 2 registers as **Sanitized Raw Evidence**.
 *
 * **The registered bytes are this projection's, never the runner's report file.** That file is left
 * byte-identical on disk by `runObservedPlaywright` and still carries `config.argv` — and, for an
 * ordinary web project, `config.webServer.env`, which is where a resolved `API_TOKEN` idiomatically
 * lives. Registering it verbatim would put a resolved secret in an immutable checksummed artifact,
 * which CONTEXT.md:371 forbids.
 *
 * **An allowlist at every nesting level, never a denylist**, for the same reason the spawn primitive
 * uses one: the reporter spreads `FullConfig`, which grows between releases and additionally absorbs
 * every caller key beginning with `@`, so a denylist is wrong the first time either happens. An element
 * whose shape this function does not recognise is DROPPED rather than passed through.
 *
 * See {@link removedRunnerReportFields} for what is removed, why that particular line is the right one,
 * and what the removal costs a reader of the artifact.
 */
export function sanitizeRunnerReport(report: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const config = report.config;
  return {
    sanitization: { policy: runnerReportSanitizationPolicy, removed: removedRunnerReportFields, note: sanitizationNote },
    ...(isRecord(config)
      ? { config: { ...pick(config, configKeys), ...("projects" in config ? { projects: projectEach(config.projects, (project) => pick(project, projectKeys)) } : {}) } }
      : {}),
    ...(isRecord(report.stats) ? { stats: pick(report.stats, statsKeys) } : {}),
    ...("suites" in report ? { suites: projectEach(report.suites, projectSuite) } : {}),
  };
}
