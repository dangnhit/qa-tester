import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const binaryExtensions = /\.(?:ico|jpg|jpeg|png|gif|webp|zip|gz|pdf|woff2?)$/i;
const patterns = [
  { name: "AWS access key", value: new RegExp("AKIA" + "[0-9A-Z]{16}") },
  { name: "private key block", value: new RegExp("-----BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----") },
  { name: "provider credential", value: /(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})/ },
  { name: "credentialed URL", value: new RegExp("https?:\\/\\/" + "[^/\\s:@]+:[^/\\s@]+@") },
] as const;
const findings: string[] = [];

for (const path of tracked) {
  if (binaryExtensions.test(path)) continue;
  const contents = await readFile(path, "utf8");
  for (const pattern of patterns) {
    if (pattern.value.test(contents)) findings.push(`${path}: ${pattern.name}`);
  }
}

try {
  execFileSync("git", ["check-ignore", "-q", "qa-results/.secret-scan-probe"]);
} catch {
  findings.push(".gitignore: qa-results/ is not ignored");
}

if (findings.length > 0) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Secret scan passed for ${tracked.length} tracked files; qa-results/ is ignored.\n`);
}
