/**
 * A minimal XML well-formedness checker, for the one thing no test on this branch did: PARSE the JUnit
 * projection instead of asserting `toContain` over its text.
 *
 * `renderSarif` is validated against the official SARIF schema, so a document it cannot produce fails
 * loudly. `renderJUnit` had no counterpart: every assertion was a substring match, which is satisfied
 * just as well by a document no parser will accept. That shared blind spot between the code and its
 * tests is why an XML-illegal control character reaching `escapeXml` had nowhere to fail.
 *
 * **Why hand-written.** Node ships no XML parser and this branch may add no dependency, runtime or dev.
 * A subprocess to a parser the machine happens to have (Python's `xml.etree`) would make the gate
 * depend on an interpreter no `package.json` declares, so the check lives here instead. It was
 * cross-validated against `xml.etree` (expat) during development over a corpus of well-formed and
 * malformed documents, agreeing on every one; that cross-check is a development step, deliberately not
 * a committed test, precisely so nothing in the suite needs Python to run.
 *
 * **Scoped to the grammar `renderJUnit` emits, and hostile to everything else.** An optional XML
 * declaration, elements, double-quoted attributes, and whitespace between tags. There is no text
 * content, no comment, no CDATA, no DTD, no processing instruction and no namespace handling, because
 * the renderer emits none — and anything outside that subset is REFUSED rather than skipped, so a
 * future renderer change that starts emitting text content fails here loudly instead of going unchecked.
 *
 * **The character rules come from the XML 1.0 spec, not from `escapeXml`.** Deriving them from the
 * implementation under test would make this agree with any bug that implementation has. `Char` is
 * `#x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]` (XML 1.0 §2.2), and it is
 * enforced over the raw document AND over every character a numeric reference resolves to — `&#0;` is
 * as illegal as a raw NUL, which is what makes "these cannot be escaped, only replaced" testable.
 *
 * Attribute values come back with XML attribute-value normalization applied (§3.3.3): a LITERAL tab, LF
 * or CR inside a value becomes a space, while `&#9;`/`&#10;`/`&#13;` do not. A test that round-trips a
 * multi-line value through this therefore measures the difference between the two.
 */

export type XmlElement = Readonly<{ name: string; attributes: ReadonlyMap<string, string> }>;

const nameStart = /[A-Za-z_:]/;
const namePart = /[A-Za-z0-9_:.-]/;
const namedEntities: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML 1.0 §2.2 `Char`. U+0000-U+0008, U+000B, U+000C, U+000E-U+001F, the surrogate range and
 *  U+FFFE/U+FFFF are outside it, in any form. */
const isXmlChar = (code: number): boolean =>
  code === 0x9 || code === 0xa || code === 0xd
  || (code >= 0x20 && code <= 0xd7ff)
  || (code >= 0xe000 && code <= 0xfffd)
  || (code >= 0x10000 && code <= 0x10ffff);

const describe = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * Every element in `document`, in document order, or a thrown `Error` naming the first violation.
 *
 * Iterating with `for...of` walks CODE POINTS, so a well-formed surrogate PAIR is seen as the one astral
 * character it encodes while a LONE surrogate is seen as itself — which is the distinction that makes an
 * unpaired surrogate detectable at all.
 */
export function parseXml(document: string): readonly XmlElement[] {
  let scanned = 0;
  for (const character of document) {
    const code = character.codePointAt(0) ?? 0;
    if (!isXmlChar(code)) throw new Error(`XML-illegal character ${describe(code)} at index ${scanned}`);
    scanned += character.length;
  }

  const elements: XmlElement[] = [];
  const open: string[] = [];
  let index = 0;
  let sawRoot = false;

  const fail = (message: string): never => { throw new Error(`${message} (at index ${index})`); };
  const at = (offset = 0): string => document[index + offset] ?? "";
  const skipSpace = (): void => { while (index < document.length && " \t\n\r".includes(at())) index += 1; };

  const readName = (): string => {
    if (!nameStart.test(at())) fail("expected an element or attribute name");
    const start = index;
    index += 1;
    while (index < document.length && namePart.test(at())) index += 1;
    return document.slice(start, index);
  };

  const readReference = (): string => {
    const end = document.indexOf(";", index);
    if (end === -1) fail("unterminated entity reference");
    const body = document.slice(index + 1, end);
    index = end + 1;
    if (!body.startsWith("#")) {
      const named = namedEntities[body];
      if (named === undefined) fail(`unknown entity reference &${body};`);
      return named ?? "";
    }
    const digits = body.startsWith("#x") || body.startsWith("#X") ? body.slice(2) : body.slice(1);
    const radix = body.startsWith("#x") || body.startsWith("#X") ? 16 : 10;
    const pattern = radix === 16 ? /^[0-9A-Fa-f]+$/ : /^[0-9]+$/;
    if (!pattern.test(digits)) fail(`malformed numeric character reference &${body};`);
    const code = parseInt(digits, radix);
    // The point of the whole exercise: a numeric reference to a character outside `Char` is exactly as
    // illegal as the raw character, so escaping a control byte is not an available repair.
    if (!isXmlChar(code)) fail(`numeric character reference &${body}; names ${describe(code)}, which XML forbids`);
    return String.fromCodePoint(code);
  };

  const readAttributeValue = (): string => {
    if (at() !== '"') fail("an attribute value must be double-quoted");
    index += 1;
    let value = "";
    while (true) {
      if (index >= document.length) fail("unterminated attribute value");
      const character = at();
      if (character === '"') { index += 1; return value; }
      if (character === "<") fail("a literal < is not allowed in an attribute value");
      if (character === "&") { value += readReference(); continue; }
      // XML 1.0 §3.3.3 attribute-value normalization: a LITERAL tab, LF or CR becomes a space before the
      // value reaches the application. A reference to one does not, which is why this parser applies the
      // rule rather than returning the raw slice.
      value += character === "\t" || character === "\n" || character === "\r" ? " " : character;
      index += 1;
    }
  };

  skipSpace();
  if (document.startsWith("<?xml", index)) {
    const close = document.indexOf("?>", index);
    if (close === -1) fail("unterminated XML declaration");
    index = close + 2;
  }

  while (true) {
    skipSpace();
    if (index >= document.length) break;
    if (at() !== "<") fail("expected a tag; this grammar allows no text content");
    if (at(1) === "?" || at(1) === "!") fail("processing instructions, comments, CDATA and DTDs are not part of this grammar");
    index += 1;

    if (at() === "/") {
      index += 1;
      const name = readName();
      skipSpace();
      if (at() !== ">") fail("unterminated end tag");
      index += 1;
      const expected = open.pop();
      if (expected !== name) fail(`</${name}> closes <${expected ?? "nothing"}>`);
      continue;
    }

    if (open.length === 0) {
      if (sawRoot) fail("a document may have only one root element");
      sawRoot = true;
    }
    const name = readName();
    const attributes = new Map<string, string>();
    while (true) {
      const before = index;
      skipSpace();
      if (document.startsWith("/>", index)) { index += 2; break; }
      if (at() === ">") { index += 1; open.push(name); break; }
      if (index === before) fail("attributes must be separated by whitespace");
      const attribute = readName();
      if (attributes.has(attribute)) fail(`duplicate attribute ${attribute}`);
      skipSpace();
      if (at() !== "=") fail("expected = after an attribute name");
      index += 1;
      skipSpace();
      attributes.set(attribute, readAttributeValue());
    }
    elements.push({ name, attributes });
  }

  if (open.length > 0) fail(`unclosed element <${open[open.length - 1] ?? ""}>`);
  if (!sawRoot) fail("no root element");
  return elements;
}

/** Every value of `attribute` across the document, in document order — the shape the JUnit tests assert
 *  against, since what matters is which messages survived the round trip and in what form. */
export function attributeValues(document: string, attribute: string): readonly string[] {
  return parseXml(document).flatMap((element) => {
    const value = element.attributes.get(attribute);
    return value === undefined ? [] : [value];
  });
}
