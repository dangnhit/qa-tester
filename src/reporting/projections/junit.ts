import { creditsCoverage } from "../../core/provenance.js";
import type { AttemptRow, ProjectionModel } from "./projection-model.js";

/** Attribute-safe escaping. `'` and `"` are escaped as well as the three structural characters,
 *  because every value this renderer emits lands inside a double-quoted attribute. */
function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    character === "&" ? "&amp;" : character === "<" ? "&lt;" : character === ">" ? "&gt;" : character === '"' ? "&quot;" : "&apos;");
}

const seconds = (milliseconds: number): string => String(Math.round(milliseconds) / 1000);

/**
 * The testcase name, prefixed with the row's own provenance when that provenance does not credit
 * coverage -- e.g. `[agent-draft] TC-1 INST-1`. This is deliberately a LABEL, not a filter.
 *
 * Inside the artifact system every claim's provenance is visible on its record, and the coverage
 * readers already gate on it: `creditsCoverage` (`src/core/provenance.ts`) is false for an
 * `agent-draft` test result, so it earns no coverage credit. A JUnit `<testcase>` element has no
 * provenance field of its own, so without this prefix an agent-drafted claim would render
 * indistinguishable from a runtime-observed one -- in the one output that leaves the artifact
 * system for a CI service.
 *
 * Dropping the row instead would be wrong: `generate-qa-report.ts:39-41` already settled that a
 * projection is a REPORT, and a report "describes what the run recorded rather than what earned
 * credit." A projection that filtered on `creditsCoverage` would hide what the run recorded, the
 * same defect that comment exists to rule out for the other projection. Marking the row -- and
 * only the anomalous row -- lets a CI reader see the fact for itself without losing it; a row
 * whose provenance already credits coverage is unaffected and renders exactly as it always has.
 *
 * Reusing `creditsCoverage` rather than re-deriving "which provenance values count" keeps this
 * label and the actual credit path from drifting apart.
 */
function testCaseName(row: AttemptRow): string {
  const name = `${row.testCaseId} ${row.testCaseInstanceId}`;
  return creditsCoverage(row.provenance) ? name : `[${row.provenance}] ${name}`;
}

type Child = Readonly<{ kind: "failure" | "error" | "skipped"; message?: string }>;

/** Status → JUnit element. FAILED is a failure; BLOCKED and INCONCLUSIVE are errors, because neither
 *  is a verdict about the product — the attempt did not reach one. NOT_RUN is skipped. */
function childOf(row: AttemptRow): Child | undefined {
  if (row.status === "FAILED") return { kind: "failure", message: `failureClassification=${row.failureClassification}` };
  if (row.status === "BLOCKED" || row.status === "INCONCLUSIVE") return { kind: "error", message: `status=${row.status}` };
  if (row.status === "NOT_RUN") return { kind: "skipped" };
  return undefined;
}

function renderCase(name: string, classname: string, time: string, child: Child | undefined): string {
  const open = `    <testcase name="${escapeXml(name)}" classname="${escapeXml(classname)}" time="${time}"`;
  if (child === undefined) return `${open}/>`;
  const inner = child.message === undefined ? `      <${child.kind}/>` : `      <${child.kind} message="${escapeXml(child.message)}"/>`;
  return `${open}>\n${inner}\n    </testcase>`;
}

function renderSuite(name: string, cases: readonly string[], counts: Readonly<{ failures: number; errors: number; skipped: number }>): string {
  return [
    `  <testsuite name="${name}" tests="${cases.length}" failures="${counts.failures}" errors="${counts.errors}" skipped="${counts.skipped}">`,
    ...cases,
    `  </testsuite>`,
  ].join("\n");
}

/** Two suites, one file. `findings` is deliberately NOT rendered: a bug or an unmet coverage obligation
 *  is not a test case, and a third suite naming them as such would overclaim in the format most likely
 *  to be read by a machine. SARIF carries them instead. */
export function renderJUnit(model: ProjectionModel): string {
  const gateCases = model.gate.verdicts.map((verdict) =>
    renderCase(verdict.rule, "gate", "0", verdict.passed ? undefined : { kind: "failure", message: verdict.reason }));
  const gateFailures = model.gate.verdicts.filter((verdict) => !verdict.passed).length;

  const children = model.attempts.map((row) => ({ row, child: childOf(row) }));
  const attemptCases = children.map(({ row, child }) => renderCase(testCaseName(row), row.executionSurface, seconds(row.durationMs), child));
  const count = (kind: Child["kind"]) => children.filter((entry) => entry.child?.kind === kind).length;

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="qa-skills" runId="${escapeXml(model.runId)}">`,
    renderSuite("qa-skills.gate", gateCases, { failures: gateFailures, errors: 0, skipped: 0 }),
    renderSuite("qa-skills.attempts", attemptCases, { failures: count("failure"), errors: count("error"), skipped: count("skipped") }),
    `</testsuites>`,
    ``,
  ].join("\n");
}
