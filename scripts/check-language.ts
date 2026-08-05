import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

/** Every precomposed letter that carries a Vietnamese diacritic, written as escapes so this file
 *  stays pure ASCII and never has to exempt itself. The set is deliberately narrower than
 *  "non-ASCII": English prose in this repo uses em dashes and curly quotes across 151 tracked
 *  files, so a non-ASCII ban is not enforceable. It is also deliberately narrower than "any Latin
 *  diacritic": C-cedilla, n-tilde, o-umlaut, a-ring, i-diaeresis and eszett are absent from the
 *  Vietnamese alphabet and stay legal, which is why `facade` spelled with a cedilla does not trip
 *  this gate. */
const vietnameseLetters =
  "[\\u00C0-\\u00C3\\u00C8-\\u00CA\\u00CC\\u00CD\\u00D2-\\u00D5\\u00D9\\u00DA\\u00DD" +
  "\\u00E0-\\u00E3\\u00E8-\\u00EA\\u00EC\\u00ED\\u00F2-\\u00F5\\u00F9\\u00FA\\u00FD" +
  "\\u0102\\u0103\\u0110\\u0111\\u0128\\u0129\\u0168\\u0169\\u01A0\\u01A1\\u01AF\\u01B0" +
  "\\u1EA0-\\u1EF9]";
const vietnamese = new RegExp(vietnameseLetters);

/** Artifact Locale is a product feature: a report rendered with `locale: "vi"` is Vietnamese by
 *  contract, and CONTEXT.md pins that the locale affects projections only while canonical machine
 *  values stay English. These four paths carry that projection's data, so Vietnamese in them is the
 *  product, not repo prose. `shared/templates/report.vi.md` needs no entry -- it is pure ASCII
 *  placeholders -- but deleting it breaks `render-markdown.ts`, which loads it by locale. */
const localeAssets = new Set([
  "src/reporting/render-markdown.ts",
  "tests/fixtures/report-golden.vi.md",
  "tests/reporting/render.test.ts",
  "tests/operations/report-generation.integration.test.ts",
]);

const binaryExtensions = /\.(?:ico|jpg|jpeg|png|gif|webp|zip|gz|pdf|woff2?)$/i;

/** NFD-encoded Vietnamese would slip past a precomposed character class, so every subject is
 *  normalized before it is tested. */
const offendingLines = (contents: string): { line: number; text: string }[] =>
  contents
    .normalize("NFC")
    .split("\n")
    .map((text, index) => ({ line: index + 1, text }))
    .filter((entry) => vietnamese.test(entry.text));

const scanFiles = async (): Promise<string[]> => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const findings: string[] = [];
  let scanned = 0;
  for (const path of tracked) {
    if (binaryExtensions.test(path) || localeAssets.has(path)) continue;
    scanned += 1;
    const contents = await readFile(path, "utf8");
    for (const entry of offendingLines(contents)) {
      findings.push(`${path}:${entry.line}: ${entry.text.trim()}`);
    }
  }
  if (findings.length === 0) {
    process.stdout.write(
      `Language scan passed for ${scanned} tracked files; ${localeAssets.size} Artifact Locale assets exempt.\n`,
    );
  }
  return findings;
};

const scanMessage = async (path: string): Promise<string[]> => {
  const raw = path === "-" ? readFileSync(0, "utf8") : await readFile(path, "utf8");
  /** A commit-msg hook is handed the file with git's own `#` scissors and help text still in it. */
  const authored = raw
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
  const findings = offendingLines(authored).map((entry) => `commit message line ${entry.line}: ${entry.text.trim()}`);
  if (findings.length === 0) process.stdout.write("Language scan passed for this commit message.\n");
  return findings;
};

const scanHistory = (range: string): string[] => {
  const separator = "\u001e";
  const field = "\u001f";
  const log = execFileSync("git", ["log", `--format=%H${field}%B${separator}`, range], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const commits = log.split(separator).map((entry) => entry.trim()).filter(Boolean);
  const findings: string[] = [];
  for (const commit of commits) {
    const [sha = "", ...rest] = commit.split(field);
    const message = rest.join(field);
    for (const entry of offendingLines(message)) {
      findings.push(`${sha.slice(0, 7)} message line ${entry.line}: ${entry.text.trim()}`);
    }
  }
  if (findings.length === 0) {
    process.stdout.write(`Language scan passed for ${commits.length} commit messages in ${range}.\n`);
  }
  return findings;
};

const [mode = "--files", argument] = process.argv.slice(2);
let findings: string[];
switch (mode) {
  case "--files":
    findings = await scanFiles();
    break;
  case "--message":
    findings = await scanMessage(argument ?? "-");
    break;
  case "--history":
    findings = scanHistory(argument ?? "HEAD");
    break;
  default:
    process.stderr.write(`Unknown mode ${mode}; expected --files, --message <path>, or --history [range]\n`);
    process.exit(2);
}

if (findings.length > 0) {
  process.stderr.write(
    `${findings.join("\n")}\n\nThis repository is English-only. Vietnamese belongs only in Artifact Locale assets.\n`,
  );
  process.exitCode = 1;
}
