import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

import { parseAuthoringDocument } from "../src/contracts/authoring.js";
import { artifactTypes, type ArtifactType } from "../src/contracts/types.js";
import { formatValidationErrors, validateArtifact } from "../src/contracts/validator.js";

/**
 * Every structured file under `examples/` is a published artifact sample, so it must satisfy the
 * contract it names. Nothing else validated this directory: `npm test` only reads `fixtures/`, and
 * a schemaVersion bump therefore silently invalidated the shipped examples twice before this ran.
 * `.md` files are prose, not artifacts, and are counted but not parsed.
 */
const examplesRoot = resolve(import.meta.dirname, "..", "examples");
const structured = new Set([".json", ".yaml", ".yml"]);

function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === "string" && (artifactTypes as readonly string[]).includes(value);
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

const failures: string[] = [];
let checked = 0;
let skipped = 0;

for (const path of await listFiles(examplesRoot)) {
  const label = relative(examplesRoot, path);
  const extension = extname(path);
  if (!structured.has(extension)) {
    skipped += 1;
    continue;
  }
  let value: unknown;
  try {
    value = parseAuthoringDocument(await readFile(path, "utf8"), extension === ".json" ? "json" : "yaml");
  } catch (error: unknown) {
    failures.push(`${label}: ${error instanceof Error ? error.message : "unparseable"}`);
    continue;
  }
  const declared = (value as Record<string, unknown>).artifactType;
  if (!isArtifactType(declared)) {
    failures.push(`${label}: declares no recognized artifactType (found ${JSON.stringify(declared)})`);
    continue;
  }
  const result = validateArtifact(declared, value);
  checked += 1;
  if (!result.valid) failures.push(`${label}: does not satisfy the ${declared} contract: ${formatValidationErrors(result.errors)}`);
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Example sweep passed: ${checked} artifact example(s) validated, ${skipped} non-artifact file(s) skipped.\n`);
}
