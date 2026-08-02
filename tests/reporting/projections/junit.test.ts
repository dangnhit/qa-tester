import { describe, expect, it } from "vitest";

import { renderJUnit } from "../../../src/reporting/projections/junit.js";
import type { AttemptRow, ProjectionModel } from "../../../src/reporting/projections/projection-model.js";
import { attributeValues, parseXml } from "./xml-wellformed.js";

// `provenance` defaults to "runtime-observed" -- a lane-2 value that DOES credit coverage
// (`creditsCoverage`, src/core/provenance.ts) -- so every baseline row in this file renders
// unprefixed, exactly as the assertions below expect. Only the provenance-label tests override it.
const attempt = (over: Partial<AttemptRow>): AttemptRow => ({
  lane: "observed-entry", id: "E-1", testCaseId: "TC-1", testCaseRevisionId: "REV-1", testCaseInstanceId: "INST-1",
  status: "PASSED", failureClassification: "NONE", executionSurface: "api", durationMs: 1500, provenance: "runtime-observed", ...over,
});

const model = (over: Partial<ProjectionModel> = {}): ProjectionModel => ({
  runId: "RUN-1", producerVersion: "0.3.0", generatedAt: "2026-07-29T00:00:00.000Z", reduced: false,
  gate: { artifactId: "gate-1", sha256: "a".repeat(64), recommendation: "NOT_READY", verdicts: [
    { rule: "VALID_ARTIFACTS", passed: true, reason: "All registered artifacts are valid." },
    { rule: "REQUIRED_COVERAGE_COMPLETE", passed: false, reason: "Required coverage missing: COV-1." },
  ] },
  attempts: [], findings: [], sourceArtifacts: [], ...over,
});

describe("renderJUnit", () => {
  it("emits one testcase per gate verdict, failing exactly the verdicts that did not pass", () => {
    const xml = renderJUnit(model());
    expect(xml).toContain(`<testsuite name="qa-skills.gate" tests="2" failures="1" errors="0" skipped="0">`);
    expect(xml).toContain(`<testcase name="VALID_ARTIFACTS" classname="gate" time="0"/>`);
    expect(xml).toContain(`<failure message="Required coverage missing: COV-1."/>`);
  });

  it("maps every attempt status to its JUnit element, and counts the suite from the rows", () => {
    const xml = renderJUnit(model({ attempts: [
      attempt({ id: "E-1", status: "PASSED" }),
      attempt({ id: "E-2", status: "FAILED", failureClassification: "PRODUCT_DEFECT" }),
      attempt({ id: "E-3", status: "BLOCKED" }),
      attempt({ id: "E-4", status: "INCONCLUSIVE" }),
      attempt({ id: "E-5", status: "NOT_RUN", durationMs: 0 }),
    ] }));
    expect(xml).toContain(`<testsuite name="qa-skills.attempts" tests="5" failures="1" errors="2" skipped="1">`);
    expect(xml).toContain(`<failure message="failureClassification=PRODUCT_DEFECT"/>`);
    expect(xml).toContain(`<error message="status=BLOCKED"/>`);
    expect(xml).toContain(`<error message="status=INCONCLUSIVE"/>`);
    expect(xml).toContain(`<skipped/>`);
  });

  it("reports a lane-1 attempt on the browser surface and converts measured milliseconds to seconds", () => {
    const xml = renderJUnit(model({ attempts: [attempt({ lane: "driven-attempt", id: "ATT-1", executionSurface: "browser", durationMs: 1500 })] }));
    expect(xml).toContain(`<testcase name="TC-1 INST-1" classname="browser" time="1.5"/>`);
  });

  it("escapes every XML metacharacter, so a reason or a test case id cannot break the document", () => {
    const xml = renderJUnit(model({
      gate: { artifactId: "g", sha256: "a".repeat(64), recommendation: "NOT_READY", verdicts: [
        { rule: "NO_SHARED_BLOCKERS", passed: false, reason: `a & b < c > d " e ' f` },
      ] },
      attempts: [attempt({ testCaseId: `TC<1>`, testCaseInstanceId: `I"1'` })],
    }));
    expect(xml).toContain(`<failure message="a &amp; b &lt; c &gt; d &quot; e &apos; f"/>`);
    expect(xml).toContain(`<testcase name="TC&lt;1&gt; I&quot;1&apos;"`);
    expect(xml).not.toMatch(/message="[^"]*[<>&](?!(amp|lt|gt|quot|apos);)/);
  });

  it("emits no findings suite: a bug is not a test case", () => {
    const xml = renderJUnit(model({ findings: [{ ruleId: "open-bug", level: "error", id: "BUG-1", message: "open bug BUG-1, severity Critical" }] }));
    expect(xml).not.toContain("BUG-1");
    expect(xml.match(/<testsuite /g)).toHaveLength(2);
  });

  // Controller decision (not in the original brief): a JUnit <testcase> has no provenance field, so
  // without a marker an agent-drafted claim (`creditsCoverage` false) would render indistinguishable
  // from a runtime-observed one. This is a LABEL, not a filter -- both rows render, only the name of
  // the non-crediting one changes -- so the difference between them is exactly what this test asserts.
  it("labels a testcase whose provenance does not credit coverage, and leaves a crediting one unprefixed", () => {
    const xml = renderJUnit(model({ attempts: [
      attempt({ id: "E-1", provenance: "agent-draft" }),
      attempt({ id: "E-2", provenance: "runtime-execution" }),
    ] }));
    expect(xml).toContain(`<testcase name="[agent-draft] TC-1 INST-1" classname="api" time="1.5"/>`);
    expect(xml).toContain(`<testcase name="TC-1 INST-1" classname="api" time="1.5"/>`);
  });
});

/**
 * The JUnit counterpart of `sarif.test.ts`'s schema-validity test, and the reason its absence mattered.
 *
 * Every assertion above is a `toContain` over the rendered text — satisfied just as well by a document
 * no parser will accept. SARIF is validated against the official schema, so a document `renderSarif`
 * cannot legally produce fails loudly; JUnit had no such check, and the code and its tests therefore
 * shared one blind spot. An XML-illegal control character had nowhere to fail: measured before the fix,
 * an `obligationId` carrying an ESC byte produced `not well-formed (invalid token): line 5, column 55`
 * from a real parser, while the export exited 0 and the sidecar certified the malformed bytes.
 *
 * `parseXml` refuses anything outside the grammar `renderJUnit` emits and enforces XML 1.0's `Char`
 * production from the spec rather than from `escapeXml`; see `xml-wellformed.ts` for why it is
 * hand-written rather than a subprocess to a parser no `package.json` declares.
 */
describe("renderJUnit output is well-formed XML", () => {
  const character = (code: number): string => String.fromCharCode(code);
  /** U+FFFD REPLACEMENT CHARACTER, written as an escape so it is visible in this source. */
  const replacement = "\uFFFD";

  /**
   * The path that makes this reachable, end to end and by real field names.
   * `coverage-obligation.schema.json` types `obligationId` as `{"type": "string", "minLength": 1}`, now
   * with a `pattern` that forbids a literal colon but nothing about control characters —
   * `hostileId` below contains none — `ingest-coverage-obligation.ts:19-24` registers the agent draft
   * verbatim, and the id reaches `release-gate.ts:96`'s `Required coverage missing: <ids>.` — this exact
   * `<failure message="...">`. Every XML-illegal class rides in on it at once.
   */
  const hostileId = `COV-${character(0x1b)}[31m${character(0x00)}${character(0x0b)}${character(0x0c)}${character(0x0e)}${character(0x1f)}${character(0xfffe)}${character(0xffff)}${character(0xd800)}-1`;

  const hostile = (reason: string): ProjectionModel => model({
    gate: { artifactId: "g", sha256: "a".repeat(64), recommendation: "NOT_READY", verdicts: [{ rule: "REQUIRED_COVERAGE_COMPLETE", passed: false, reason }] },
  });

  it("parses as XML when an unpatterned obligationId carries every XML-illegal character class", () => {
    const xml = renderJUnit(hostile(`Required coverage missing: ${hostileId}.`));

    expect(() => parseXml(xml)).not.toThrow();
    // Replaced, not stripped: one U+FFFD per illegal character, so a damaged id stays visibly damaged
    // rather than silently becoming a shorter identifier that names some other obligation.
    expect(attributeValues(xml, "message")).toEqual([`Required coverage missing: COV-${replacement}[31m${replacement.repeat(8)}-1.`]);
  });

  it.each([
    ["NUL", 0x00], ["backspace", 0x08], ["vertical tab", 0x0b], ["form feed", 0x0c],
    ["shift out", 0x0e], ["unit separator", 0x1f], ["escape", 0x1b],
    ["U+FFFE", 0xfffe], ["U+FFFF", 0xffff], ["an unpaired high surrogate", 0xd800], ["an unpaired low surrogate", 0xdc00],
  ])("parses as XML with %s in a gate reason, one class at a time", (_label, code) => {
    const xml = renderJUnit(hostile(`before${character(code)}after`));

    expect(() => parseXml(xml)).not.toThrow();
    expect(attributeValues(xml, "message")).toEqual([`before${replacement}after`]);
  });

  /**
   * The second half, which well-formedness alone cannot catch: tab, LF and CR are LEGAL XML, so a
   * document carrying them literally parses fine — and loses the data anyway. XML attribute-value
   * normalization (XML 1.0 §3.3.3) turns every literal one inside an attribute value into a space
   * before the value reaches the application. Measured against expat before the fix:
   * `first line\nsecond\tline\rthird` came back as `first line second line third`. Numeric references
   * are exempt from that normalization, so the round trip is exact.
   */
  it("round-trips a multi-line reason exactly, rather than letting attribute-value normalization flatten it", () => {
    const reason = "first line\nsecond\tline\rthird";

    const xml = renderJUnit(hostile(reason));

    expect(xml).toContain("&#10;");
    expect(attributeValues(xml, "message")).toEqual([reason]);
  });

  /**
   * A surrogate PAIR is one legal astral character, not two illegal halves, and must survive whole.
   * `escapeXml` iterates code points for exactly this reason: iterating UTF-16 units instead would see
   * U+1F600 as U+D83D followed by U+DE00, find neither in `Char`, and replace a perfectly legal emoji
   * in a test case title with two U+FFFD. The repair for an unpaired surrogate must not damage a paired
   * one, and only an astral fixture can tell the two implementations apart.
   */
  it("leaves an astral character whole, rather than replacing both halves of a legal surrogate pair", () => {
    const xml = renderJUnit(model({ attempts: [attempt({ testCaseId: "TC-\u{1F600}-\u{1D11E}" })] }));

    expect(() => parseXml(xml)).not.toThrow();
    expect(attributeValues(xml, "name")).toContain("TC-\u{1F600}-\u{1D11E} INST-1");
  });

  it("parses as XML, and round-trips every metacharacter, for an ordinary model with both suites populated", () => {
    const xml = renderJUnit(model({ attempts: [
      attempt({ id: "E-1", status: "FAILED", failureClassification: "PRODUCT_DEFECT" }),
      attempt({ id: "E-2", status: "NOT_RUN", provenance: "agent-draft", testCaseId: `TC<1>&"'` }),
    ] }));

    const elements = parseXml(xml);

    expect(elements.map((element) => element.name)).toEqual([
      "testsuites", "testsuite", "testcase", "testcase", "failure", "testsuite", "testcase", "failure", "testcase", "skipped",
    ]);
    expect(elements.find((element) => element.name === "testsuites")?.attributes.get("runId")).toBe("RUN-1");
    expect(elements.filter((element) => element.name === "testcase").map((element) => element.attributes.get("name")))
      .toEqual(["VALID_ARTIFACTS", "REQUIRED_COVERAGE_COMPLETE", "TC-1 INST-1", `[agent-draft] TC<1>&"' INST-1`]);
  });
});

/**
 * **The checker's own negative assertions, and the reason they exist.**
 *
 * Every assertion in the block above is `.not.toThrow()` plus an equality on what came back. Not one of
 * them fails if `parseXml` stops rejecting things — delete the `Char` scan at `xml-wellformed.ts:59-63`
 * and all 15 stay green. That is this branch's signature defect, a test that passes with the feature
 * removed, sitting inside the checker that carries I4's entire guarantee. And it is I4's own structural
 * point one level up: I4 existed because JUnit had no independent validator the way SARIF has a schema,
 * and a hand-written validator with no negative assertions is a validator that cannot fail.
 *
 * The expat cross-validation is real evidence but it is a development step that does not run in CI, so
 * nothing but these assertions keeps the checker honest tomorrow.
 *
 * Each case asserts the SPECIFIC message, so it reds for the reason named rather than incidentally, and
 * each names the guard it pins. They do NOT all pin the same guard — that is the point of listing them
 * separately, and the mutation evidence in the report is per guard rather than one blanket run.
 */
describe("parseXml rejects", () => {
  const character = (code: number): string => String.fromCharCode(code);
  const declaration = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  const document = (body: string): string => `${declaration}${body}\n`;

  /** Pins the `Char` scan over the raw document (`xml-wellformed.ts:59-63`) — the guard whose deletion
   *  left all 15 positive tests green, and the one that carries I4's guarantee that a rendered document
   *  contains no character XML forbids. Every class the renderer must neutralize is listed. */
  it.each([
    ["NUL", 0x00, "U\\+0000"],
    ["backspace", 0x08, "U\\+0008"],
    ["vertical tab", 0x0b, "U\\+000B"],
    ["form feed", 0x0c, "U\\+000C"],
    ["shift out", 0x0e, "U\\+000E"],
    ["escape", 0x1b, "U\\+001B"],
    ["unit separator", 0x1f, "U\\+001F"],
    ["U+FFFE", 0xfffe, "U\\+FFFE"],
    ["U+FFFF", 0xffff, "U\\+FFFF"],
    ["an unpaired high surrogate", 0xd800, "U\\+D800"],
    ["an unpaired low surrogate", 0xdc00, "U\\+DC00"],
  ])("a raw %s in the document", (_label, code, named) => {
    expect(() => parseXml(document(`<r m="a${character(code)}b"/>`)))
      .toThrow(new RegExp(`XML-illegal character ${named}`));
  });

  /** Pins the SECOND legality check, in `readReference` — a numeric reference naming a character outside
   *  `Char` is exactly as illegal as the raw byte, which is the whole reason `escapeXml` replaces rather
   *  than escapes. This is a different guard from the document scan and survives that guard's deletion,
   *  because the reference resolves to its character only after the raw scan has already run. */
  it.each([
    ["decimal, NUL", "&#0;", "&#0; names U\\+0000"],
    ["decimal, escape", "&#27;", "&#27; names U\\+001B"],
    ["hexadecimal, escape", "&#x1b;", "&#x1b; names U\\+001B"],
    ["hexadecimal, U+FFFF", "&#xFFFF;", "&#xFFFF; names U\\+FFFF"],
  ])("a numeric character reference to an illegal character (%s)", (_label, reference, named) => {
    expect(() => parseXml(document(`<r m="a${reference}b"/>`)))
      .toThrow(new RegExp(`numeric character reference ${named}, which XML forbids`));
  });

  /** Pins the tag-balancing guards. A checker that accepted these would accept a truncated projection —
   *  exactly what a CI artifact store cutting a file short produces. */
  it("a mismatched end tag", () => {
    expect(() => parseXml(document(`<r><c></d></r>`))).toThrow(/<\/d> closes <c>/);
  });

  it("an unclosed element", () => {
    expect(() => parseXml(document(`<r><c/>`))).toThrow(/unclosed element <r>/);
  });

  it("a second root element", () => {
    expect(() => parseXml(document(`<r/><s/>`))).toThrow(/only one root element/);
  });

  /** Pins `readReference`'s parsing. A bare `&` is the classic un-escaped-metacharacter defect, and the
   *  positive tests can only show that `&amp;` round-trips — never that a raw one is refused. */
  it("a bare ampersand", () => {
    expect(() => parseXml(document(`<r m="a&b"/>`))).toThrow(/unterminated entity reference/);
  });

  it("an entity reference XML does not define", () => {
    expect(() => parseXml(document(`<r m="a&nbsp;b"/>`))).toThrow(/unknown entity reference &nbsp;/);
  });

  it("a malformed numeric character reference", () => {
    expect(() => parseXml(document(`<r m="a&#zz;b"/>`))).toThrow(/malformed numeric character reference &#zz;/);
  });

  /** Pins the attribute-value rules. `renderJUnit` puts every value it emits inside a double-quoted
   *  attribute, so these are the guards that make the positive round-trip assertions mean anything. */
  it("a literal < inside an attribute value", () => {
    expect(() => parseXml(document(`<r m="a<b"/>`))).toThrow(/a literal < is not allowed in an attribute value/);
  });

  it("an unquoted attribute value", () => {
    expect(() => parseXml(document(`<r m=1/>`))).toThrow(/an attribute value must be double-quoted/);
  });

  it("an unterminated attribute value", () => {
    expect(() => parseXml(document(`<r m="a`))).toThrow(/unterminated attribute value/);
  });

  it("the same attribute twice", () => {
    expect(() => parseXml(document(`<r a="1" a="2"/>`))).toThrow(/duplicate attribute a/);
  });

  /** Pins the declared hostility to everything outside the grammar `renderJUnit` emits. This is what
   *  makes a future renderer change that starts emitting text content fail loudly here rather than
   *  quietly widening what the checker will accept. */
  it("text content, which this renderer never emits", () => {
    expect(() => parseXml(document(`<r>hello</r>`))).toThrow(/no text content/);
  });

  it("a comment, which is legal XML but outside this grammar", () => {
    expect(() => parseXml(document(`<!-- hi --><r/>`))).toThrow(/comments, CDATA and DTDs are not part of this grammar/);
  });

  /** The positive control for the whole block: the same construction that every rejection above is a
   *  one-character mutation of must still be accepted. Without it, a checker that threw unconditionally
   *  would satisfy every assertion above. */
  it("but accepts the well-formed document each of those is a mutation of", () => {
    expect(() => parseXml(document(`<r m="a&amp;b&#10;c"><c/></r>`))).not.toThrow();
  });
});
