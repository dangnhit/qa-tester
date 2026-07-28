import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "json-schema-to-typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDirectory = join(root, "shared", "schemas");
const outputDirectory = join(root, "src", "contracts", "generated");

function interfaceName(filename: string): string {
  return filename
    .replace(/\.schema\.json$/, "")
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

type StringEnumSchema = { enum: string[] };
type ConstSchema = { const: string };
type ObjectSchema = {
  properties: {
    mode: StringEnumSchema;
    status: StringEnumSchema;
    schemaVersion: ConstSchema;
    finalizedProfile: { properties: { version: ConstSchema } };
  };
};

function quotedUnion(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(" | ");
}

function runMetadataDeclaration(schema: ObjectSchema): string {
  const modes = quotedUnion(schema.properties.mode.enum);
  const activeStatuses = quotedUnion(schema.properties.status.enum.slice(0, 3));
  const terminalStatuses = quotedUnion(schema.properties.status.enum.slice(3));
  const schemaVersion = JSON.stringify(schema.properties.schemaVersion.const);
  const profileVersion = JSON.stringify(schema.properties.finalizedProfile.properties.version.const);
  return `/* This file is generated from shared/schemas. Do not edit manually. */

type QARunMode = ${modes};
type ActiveRunStatus = ${activeStatuses};
type TerminalRunStatus = ${terminalStatuses};

type QARunMetadataBase<M extends QARunMode> = {
  artifactType: "run-metadata";
  schemaVersion: ${schemaVersion};
  producerVersion: string;
  runId: string;
  createdAt: string;
  mode: M;
  environmentProfileId: string;
  linkedRunId?: string;
};

type ActiveQARunMetadata<M extends QARunMode> = QARunMetadataBase<M> & {
  status: ActiveRunStatus;
  finalizedProfile?: never;
};

type TerminalQARunMetadata<M extends QARunMode> = QARunMetadataBase<M> & {
  status: TerminalRunStatus;
  finalizedProfile: {
    name: M;
    version: ${profileVersion};
  };
};

export type QARunMetadata = {
  [M in QARunMode]: ActiveQARunMetadata<M> | TerminalQARunMetadata<M>;
}[QARunMode];
`;
}

/**
 * `json-schema-to-typescript`'s handling of `allOf` is depth-dependent, and both depths degrade the
 * emitted type rather than rejecting the schema — so a schema author gets no error, and `check:generated`
 * gives no warning either, because it only diffs the committed `.d.ts` against a re-run of this same
 * (broken) generator: a stable-but-degraded output stays green.
 *
 * At the schema ROOT — e.g. `coverage-obligation.schema.json`'s two-branch conditional — `allOf`
 * degrades the type to an intersection with a bare `{ [k: string]: unknown | undefined }` index
 * signature, but every named property survives alongside it (see `coverage-obligation.d.ts`, whose
 * root-level index signature is exactly this). Cosmetic, and safe to leave as `allOf`.
 *
 * NESTED one level down — inside an array item, as `test-result-batch.schema.json`'s per-entry
 * conditional needed — the same construct is destructive rather than cosmetic: the entire nested
 * object's property set is REPLACED by the bare index signature, with nothing surviving alongside it.
 * Discovered while adding that entry's `executionSurface`-gated `observedEngine`/`viewport` (Task 36):
 * copying the obligation's `allOf` shape into the entry silently deleted every entry field from the
 * generated contract. The fix for a NESTED conditional is `if`/`then`/`else` on that nested schema
 * instead of `allOf` (verified across five variants — see `tests/contracts/validator.test.ts`'s
 * `test-result-batch schema` describe block), which preserves every property and validates identically
 * under Ajv strict. A ROOT-level conditional has no need to make that switch.
 */
async function generate(): Promise<void> {
  const schemaFiles = (await readdir(schemaDirectory)).filter((filename) => filename.endsWith(".schema.json")).sort();
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  for (const filename of schemaFiles) {
    const schema = JSON.parse(await readFile(join(schemaDirectory, filename), "utf8")) as ObjectSchema;
    const declaration = filename === "run-metadata.schema.json"
      ? runMetadataDeclaration(schema)
      : await compile(schema, interfaceName(filename), {
        bannerComment: "/* This file is generated from shared/schemas. Do not edit manually. */",
        strictIndexSignatures: true,
      });
    await writeFile(join(outputDirectory, `${parse(filename).name.replace(".schema", "")}.d.ts`), declaration);
  }
}

await generate();
