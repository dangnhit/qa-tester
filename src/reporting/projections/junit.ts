import { creditsCoverage } from "../../core/provenance.js";
import type { AttemptRow, ProjectionModel } from "./projection-model.js";

const namedEntities: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const numericReferences: Readonly<Record<string, string>> = { "\t": "&#9;", "\n": "&#10;", "\r": "&#13;" };

/** XML 1.0 §2.2's `Char` production, written out clause for clause so it can be compared against the
 *  spec rather than mentally inverted from a negated range:
 *  `#x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]`. Everything outside it —
 *  U+0000-U+0008, U+000B, U+000C, U+000E-U+001F, the surrogate range, U+FFFE and U+FFFF — is forbidden
 *  in an XML 1.0 document in any form. `tests/reporting/projections/xml-wellformed.ts` states the same
 *  production a second time on purpose: a checker that imported this one would agree with any mistake
 *  in it. */
const isXmlChar = (code: number): boolean =>
  code === 0x9 || code === 0xa || code === 0xd
  || (code >= 0x20 && code <= 0xd7ff)
  || (code >= 0xe000 && code <= 0xfffd)
  || (code >= 0x10000 && code <= 0x10ffff);

/**
 * Attribute-safe escaping, in three parts. `'` and `"` are escaped as well as the three structural
 * characters, because every value this renderer emits lands inside a double-quoted attribute.
 *
 * **XML-ILLEGAL CHARACTERS ARE REPLACED WITH U+FFFD, because escaping them is not possible.** XML 1.0's
 * `Char` production admits only `#x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]`,
 * so U+0000–U+0008, U+000B, U+000C, U+000E–U+001F, U+FFFE, U+FFFF and unpaired surrogates are forbidden
 * IN ANY FORM — a numeric character reference for one is just as illegal as the raw byte. One of them
 * anywhere in this document makes the whole file unparseable, and the projection is lost entire: the
 * export still exits 0 and the sidecar still certifies the malformed bytes.
 *
 * It is reachable. `coverage-obligation.schema.json` types `obligationId` as `{"type": "string",
 * "minLength": 1}`, now with a `pattern` that forbids a literal colon but nothing about control
 * characters, and `ingest-coverage-obligation.ts:19-24` registers the agent draft verbatim, and that id
 * reaches `ruleInputs.coverage.requiredMissing` and from there the `REQUIRED_COVERAGE_COMPLETE` reason
 * `evaluateReleaseGate` composes in src/reporting/release-gate.ts — `Required coverage missing: <ids>.`,
 * straight into a `<failure message="...">`.
 * Measured on this runtime: an id carrying an ESC byte produced `not well-formed (invalid token)` from a
 * real parser. `projection-model.ts`'s `identifierOnlyGateRules` names the same field as the one nothing
 * in code protects.
 *
 * REPLACED rather than stripped, deliberately. Stripping silently changes the string's shape and can
 * FUSE two tokens that were separated -- `COV-1<NUL>COV-2` becomes `COV-1COV-2`, a plausible identifier
 * naming neither obligation -- so a reader cannot tell a damaged id from a real one. U+FFFD is Unicode's
 * own marker for "a character was here that cannot be represented", is itself legal XML (it is the top
 * of the `[#xE000-#xFFFD]` range), and keeps one character per character removed, so the damage stays
 * visible. It is the same ruling this branch has made throughout: MARK the anomalous thing, do not drop
 * it. The cost is that a payload which already contained U+FFFD is indistinguishable from one that was
 * repaired, which is what that character means anyway.
 *
 * One qualification, so nobody later deletes the surrogate range believing it saves the file or keeps it
 * believing it must: Node's UTF-8 encoder ALREADY substitutes U+FFFD for an unpaired surrogate, so
 * `Buffer.from(renderJUnit(model), "utf8")` would produce a well-formed file with or without it
 * (measured). What this covers is the RETURNED STRING, whose contract is that it is well-formed XML —
 * not "well-formed once you happen to encode it as UTF-8". The control-character and U+FFFE/U+FFFF
 * ranges have no such encoder backstop and are load-bearing for the file itself.
 *
 * **TAB, LF and CR become NUMERIC REFERENCES rather than travelling literally.** All three are legal
 * XML, so this is not about well-formedness: XML attribute-value normalization (XML 1.0 §3.3.3) replaces
 * every literal one inside an attribute value with a SPACE before the value reaches the application.
 * Measured: a reason reading `first line\nsecond\tline\rthird` parsed back as
 * `first line second line third`. A gate reason is the one value here that can legitimately be
 * multi-line, and flattening it silently is the same class of loss as dropping it. `&#9;`/`&#10;`/`&#13;`
 * are exempt from that normalization and survive as themselves.
 */
function escapeXml(value: string): string {
  let escaped = "";
  // `for...of` iterates CODE POINTS: a well-formed surrogate PAIR is seen as the one astral character it
  // encodes and passes through untouched, while a LONE surrogate is seen as itself and fails `isXmlChar`.
  // Iterating by UTF-16 unit instead would mangle every emoji in a test case title.
  for (const character of value) {
    // Order matters: tab, LF and CR are legal `Char`s, so the numeric-reference lookup has to come
    // before the legality test or they would pass through literally and be flattened to spaces.
    escaped += namedEntities[character] ?? numericReferences[character]
      ?? (isXmlChar(character.codePointAt(0) ?? 0) ? character : "\uFFFD");
  }
  return escaped;
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
