import type { ExecutionStatus, FailureClassification } from "../contracts/types.js";
import { QaSkillsError } from "../core/errors.js";
import { array, isRecord } from "../core/values.js";

/** The Execution Surfaces a `test-result-batch` ENTRY may name, minus `browser`. The schema's own enum
 *  is the six non-`manual` surfaces; lane 2 additionally refuses `browser` because Playwright's JSON
 *  reporter reports neither the engine nor the viewport a browser entry is REQUIRED to carry, and the
 *  QA Runtime executes that surface itself (CONTEXT.md:444). Ordered as the schema orders them. */
export const observedEntrySurfaces = ["api", "unit", "integration", "performance", "security"] as const;
export type ObservedEntrySurface = (typeof observedEntrySurfaces)[number];

/** The identity triple a registered `test-case` is matched on — the same triple `testResultBatchRule`
 *  and both coverage readers key on, spelled in the batch entry's field names. */
export type RegisteredCase = Readonly<{ testCaseId: string; testCaseRevisionId: string; testCaseInstanceId: string }>;

/** One `test-result-batch` entry, minus nothing: this is exactly the object the producer registers.
 *  `observedEngine` and `viewport` are absent by construction — the schema FORBIDS them off the browser
 *  surface, and lane 2 never produces a browser entry. */
export type ObservedEntry = Readonly<{
  entryId: string;
  testCaseId: string;
  testCaseRevisionId: string;
  testCaseInstanceId: string;
  status: ExecutionStatus;
  failureClassification: FailureClassification;
  executionSurface: ObservedEntrySurface;
  steps: readonly Readonly<{ stepId: string; status: ExecutionStatus; durationMs: number }>[];
}>;

/** A spec the runner executed that the batch cannot carry, with the reason a human needs to act on it.
 *  Excluded rather than refused: the batch rule requires each entry to match exactly one registered
 *  `test-case`, so an unmatched spec cannot be an entry at all — and an external suite legitimately
 *  contains specs this QA Run never planned. */
export type ExcludedSpec = Readonly<{ entryId: string; title: string; file: string; reason: string }>;

export type ObservedMapping = Readonly<{ entries: readonly ObservedEntry[]; excluded: readonly ExcludedSpec[] }>;

/** The identity tag, in the spec's own `test(...)` title. Anchored on `[qa:` and closed by `]`, with
 *  every component forbidden from containing the delimiters, so a title that merely mentions `qa:` does
 *  not parse and a tag missing a component does not silently match a shorter one. */
const identityTagPattern = /\[qa:([^\][/@\s]+)\/([^\][/@\s]+)\/([^\][/@\s]+)@([^\][/@\s]+)\]/g;
/** What a tag ATTEMPT looks like, so a malformed one is refused rather than read as "no tag at all".
 *  A spec carrying no `[qa:` marker is a positive statement that it is not QA-identified; a spec
 *  carrying a broken one is an assertion this runtime cannot honour, and guessing is what lane 2 exists
 *  not to do. */
const identityTagMarker = "[qa:";

/**
 * The runner's per-EXECUTION statuses, and the only five `@playwright/test` 1.61 emits on a result.
 *
 * **A runner reports failure, never a cause.** CONTEXT.md:43-44 makes Failure Classification a
 * *diagnosis* ("the diagnosed source of a non-passing outcome"), while CONTEXT.md:39-40 makes Execution
 * Status "the observed outcome of executing or scheduling a test case, **independent of its diagnosed
 * cause**". A reporter observes the outcome and diagnoses nothing, so every non-passing status maps to
 * `UNDETERMINED` and no mapping here can ever produce `PRODUCT_DEFECT` or `TEST_DEFECT`. `PASSED` pairs
 * with `NONE`, which `testResultBatchRule` enforces as a biconditional.
 *
 * The three easy ones to get wrong, each justified rather than assumed:
 *
 * - **`timedOut` -> `FAILED`.** The test executed and did not reach its expected outcome; Playwright
 *   itself counts it in `stats.unexpected`. `INCONCLUSIVE` is the plausible-but-wrong answer: it says
 *   "we could not tell whether the product is broken", which is a statement about the CAUSE, and the
 *   cause already has its own field carrying `UNDETERMINED`.
 * - **`skipped` -> `NOT_RUN`.** Nothing executed, which is what `NOT_RUN` means and what CONTEXT.md:350
 *   ties it to ("a test case with `NOT_RUN` has no Test Attempt"). `BLOCKED` is the plausible-but-wrong
 *   answer: a `test.skip()` is the suite's own decision not to run, not an external obstruction.
 * - **`interrupted` -> `BLOCKED`.** The runner aborted the whole execution (a global timeout,
 *   `--max-failures`, an operator signal) after this test began, so no outcome was ever observed. That
 *   is an external obstruction, which is exactly how lane 1 uses `BLOCKED`
 *   (`execute-browser-test.ts:82`, a safety-denied step). `FAILED` is the plausible-but-wrong answer:
 *   nothing failed, the observation was cut off.
 */
const resultStatuses: Readonly<Record<string, Readonly<{ status: ExecutionStatus; failureClassification: FailureClassification }>>> = {
  passed: { status: "PASSED", failureClassification: "NONE" },
  failed: { status: "FAILED", failureClassification: "UNDETERMINED" },
  timedOut: { status: "FAILED", failureClassification: "UNDETERMINED" },
  skipped: { status: "NOT_RUN", failureClassification: "UNDETERMINED" },
  interrupted: { status: "BLOCKED", failureClassification: "UNDETERMINED" },
};

type ParsedTag = Readonly<{ testCaseId: string; testCaseRevisionId: string; testCaseInstanceId: string; surface: string }>;
type SpecView = Readonly<{ entryId: string; title: string; file: string; test: Readonly<Record<string, unknown>> }>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Flattens the reporter's suite tree. `_serializeSuite` nests `suites` for every `describe`, and
 *  `_mergeSuites` merges the same spec across projects into ONE spec carrying one `tests` entry per
 *  project — so the unit that maps to a batch entry is a (spec, test) pair, not a spec. */
function specViews(node: unknown): SpecView[] {
  if (!isRecord(node)) return [];
  return [
    ...array(node.suites).flatMap(specViews),
    ...array(node.specs).flatMap((spec) => {
      if (!isRecord(spec)) return [];
      const id = text(spec.id);
      const title = text(spec.title);
      const file = text(spec.file);
      return array(spec.tests).flatMap((test, index) => isRecord(test) ? [{ entryId: `${id}-${index}`, title, file, test }] : []);
    }),
  ];
}

/**
 * Every distinct spec file the runner reported executing, exactly as the reporter spelled it —
 * `path.relative(config.rootDir, …)` in POSIX form, so a caller resolves it against `config.rootDir`.
 *
 * Separate from `mapObservedReport` because it answers a question that must be settled BEFORE any
 * entry is interpreted: whether what ran is what the git anchor describes. It therefore reports EVERY
 * executed spec, tagged or not — an untagged spec outside the anchored directory credits nothing by
 * itself, but its execution still falsifies the batch's `specTreeSha256` as a description of the run.
 */
export function observedSpecFiles(report: Readonly<Record<string, unknown>>): readonly string[] {
  return [...new Set(array(report.suites).flatMap(specViews).map((view) => view.file))];
}

function parseIdentityTag(view: SpecView): ParsedTag | undefined {
  const matches = [...view.title.matchAll(identityTagPattern)];
  if (matches.length > 1) {
    throw new QaSkillsError(
      `The spec ${JSON.stringify(view.title)} in ${view.file} carries two identity tags, so it does not say which registered test case ran. `
      + `Give each test exactly one [qa:<testCaseId>/<revisionId>/<instanceId>@<surface>] tag.`,
      "OBSERVED_SPEC_TAG_INVALID",
    );
  }
  // Counted, not merely "is there one when nothing matched". A well-formed tag contains exactly one
  // `[qa:` marker, so any surplus marker is a tag this parser could not read — INCLUDING one sitting
  // beside a tag it could. Keying only on `matches.length === 0` would let
  // `"a [qa:BROKEN] b [qa:TC/REV/INST@api]"` map silently, which contradicts the ruling below.
  const markers = view.title.split(identityTagMarker).length - 1;
  if (markers !== matches.length) {
    throw new QaSkillsError(
      `The spec ${JSON.stringify(view.title)} in ${view.file} starts an identity tag it does not complete. `
      + `The form is [qa:<testCaseId>/<revisionId>/<instanceId>@<surface>], and a broken tag is refused rather than read as an untagged spec: `
      + `an untagged spec says it is not QA-identified, a broken one asserts an identity this runtime cannot resolve.`,
      "OBSERVED_SPEC_TAG_INVALID",
    );
  }
  const match = matches[0];
  if (match === undefined) return undefined;
  return { testCaseId: match[1] ?? "", testCaseRevisionId: match[2] ?? "", testCaseInstanceId: match[3] ?? "", surface: match[4] ?? "" };
}

function assertSurface(view: SpecView, tag: ParsedTag): ObservedEntrySurface {
  if (tag.surface === "browser") {
    throw new QaSkillsError(
      `The spec ${JSON.stringify(view.title)} in ${view.file} declares the browser Execution Surface, which a Runtime-Observed Execution cannot report. `
      + `A browser batch entry is required to carry the engine and the viewport it ran at, and Playwright's JSON reporter exposes neither — synthesising them from a `
      + `declaration would credit a Browser Matrix member nothing was observed on (CONTEXT.md:441-442). The QA Runtime executes the browser surface itself `
      + `(CONTEXT.md:444): run this case through \`qa-skill\` lane 1 (execute-browser-test) instead, or retag it with the surface it really exercises.`,
      "OBSERVED_SPEC_SURFACE_UNSUPPORTED",
    );
  }
  const surface = (observedEntrySurfaces as readonly string[]).includes(tag.surface) ? tag.surface as ObservedEntrySurface : undefined;
  if (surface === undefined) {
    throw new QaSkillsError(
      `The spec ${JSON.stringify(view.title)} in ${view.file} declares the Execution Surface ${JSON.stringify(tag.surface)}, which a batch entry cannot carry. `
      + `A Runtime-Observed Execution may report: ${observedEntrySurfaces.join(", ")}. `
      + `"manual" is excluded because a human's evaluation has no spec tree to hash, and "browser" because the runtime executes that surface itself.`,
      "OBSERVED_SPEC_TAG_INVALID",
    );
  }
  return surface;
}

/** The result's own reported duration, floored at the contract's `minimum: 0`. A result the runner
 *  reported without a usable duration contributes `0` rather than blocking the whole run: the duration
 *  is descriptive, and the STATUS — the part a Coverage Obligation is credited from — is refused
 *  outright when it cannot be classified. A negative or non-finite value is treated the same way,
 *  because the schema would reject it and an entry that cannot be registered helps nobody. */
function durationOf(result: unknown): number {
  const duration = isRecord(result) ? result.duration : undefined;
  return typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

function mapResultStatus(view: SpecView, status: unknown): Readonly<{ status: ExecutionStatus; failureClassification: FailureClassification }> {
  const mapped = typeof status === "string" ? resultStatuses[status] : undefined;
  if (mapped === undefined) {
    throw new QaSkillsError(
      `The spec ${JSON.stringify(view.title)} in ${view.file} produced the runner result status ${JSON.stringify(status)}, which this runtime cannot classify. `
      + `The recognised statuses are: ${Object.keys(resultStatuses).join(", ")}. A status is refused rather than mapped to a guess, because an Execution Status `
      + `nobody observed is exactly the fabrication a Runtime-Observed Execution exists to rule out.`,
      "OBSERVED_RESULT_STATUS_UNRECOGNIZED",
    );
  }
  return mapped;
}

/**
 * Maps one observed Playwright report onto `test-result-batch` entries.
 *
 * **Identity comes from a tag inside the spec tree, never from a flag beside it.**
 * `[qa:<testCaseId>/<revisionId>/<instanceId>@<surface>]` in the `test(...)` title is covered by the
 * batch's own `specTreeSha256`, so whoever merged the spec reviewed the claim; a CLI flag would sit
 * outside the anchor, where it could be changed without dirtying the tree. Titles of enclosing
 * `describe` blocks are NOT searched: the reporter keeps them in the suite chain, and only the leaf
 * title belongs to the test that ran.
 *
 * **Excluded versus refused is a real distinction, not a severity.** A spec with no tag, or a tag that
 * resolves to no registered test case, is EXCLUDED and reported — an external suite legitimately holds
 * specs this QA Run never planned, and `testResultBatchRule` requires every entry to match exactly one
 * registered test case, so such a spec cannot be carried at all. Everything else REFUSES the whole run:
 * an ambiguous identity means the workspace cannot tell which case ran, a malformed or unsupported
 * surface tag asserts something the contract cannot express, and an unclassifiable result status has no
 * honest mapping.
 *
 * **Steps are the runner's retries, not the suite's `test.step`s.** One entry step per result, in the
 * order the runner reported them, with a generated `stepId`. The reporter's own `steps[].title` is
 * spec-authored free text with no stable identity and is deliberately never copied into an immutable
 * artifact; `testResultBatchRule` correspondingly does not check a batch entry's steps against any
 * canonical step list, because an observed execution has none.
 *
 * Every refusal is a `QaSkillsError`; this function reads its input and writes nothing.
 */
export function mapObservedReport(report: Readonly<Record<string, unknown>>, registeredCases: readonly RegisteredCase[]): ObservedMapping {
  const entries: ObservedEntry[] = [];
  const excluded: ExcludedSpec[] = [];
  for (const view of array(report.suites).flatMap(specViews)) {
    const tag = parseIdentityTag(view);
    if (tag === undefined) {
      excluded.push({ entryId: view.entryId, title: view.title, file: view.file, reason: "no [qa:<testCaseId>/<revisionId>/<instanceId>@<surface>] tag in the test title" });
      continue;
    }
    const identity = `${tag.testCaseId}/${tag.testCaseRevisionId}/${tag.testCaseInstanceId}`;
    const executionSurface = assertSurface(view, tag);
    const matches = registeredCases.filter((candidate) => candidate.testCaseId === tag.testCaseId
      && candidate.testCaseRevisionId === tag.testCaseRevisionId && candidate.testCaseInstanceId === tag.testCaseInstanceId);
    if (matches.length > 1) {
      throw new QaSkillsError(
        `The spec ${JSON.stringify(view.title)} in ${view.file} names the test case ${identity}, which ${matches.length} registered test cases carry. `
        + `An ambiguous identity is refused rather than excluded: it means this workspace cannot tell which registered case the spec ran.`,
        "OBSERVED_SPEC_CASE_AMBIGUOUS",
      );
    }
    if (matches.length === 0) {
      excluded.push({ entryId: view.entryId, title: view.title, file: view.file, reason: `the tag names ${identity}, which resolves to no registered test case in this run` });
      continue;
    }
    const steps = array(view.test.results).map((item, index) => ({ stepId: `result-${index}`, ...mapResultStatus(view, isRecord(item) ? item.status : undefined), durationMs: durationOf(item) }));
    const last = steps.at(-1);
    if (last === undefined) {
      throw new QaSkillsError(
        `The spec ${JSON.stringify(view.title)} in ${view.file} was reported with no result at all, so nothing about it was observed. `
        + `An entry is refused rather than recorded with an invented status.`,
        "OBSERVED_RESULT_STATUS_UNRECOGNIZED",
      );
    }
    entries.push({
      entryId: view.entryId,
      testCaseId: tag.testCaseId, testCaseRevisionId: tag.testCaseRevisionId, testCaseInstanceId: tag.testCaseInstanceId,
      status: last.status, failureClassification: last.failureClassification, executionSurface,
      steps: steps.map((step) => ({ stepId: step.stepId, status: step.status, durationMs: step.durationMs })),
    });
  }
  return { entries, excluded };
}
