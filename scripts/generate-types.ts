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
