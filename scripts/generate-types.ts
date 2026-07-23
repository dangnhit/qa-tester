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

async function generate(): Promise<void> {
  const schemaFiles = (await readdir(schemaDirectory)).filter((filename) => filename.endsWith(".schema.json")).sort();
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  for (const filename of schemaFiles) {
    const schema = JSON.parse(await readFile(join(schemaDirectory, filename), "utf8")) as object;
    const declaration = await compile(schema, interfaceName(filename), {
      bannerComment: "/* This file is generated from shared/schemas. Do not edit manually. */",
      strictIndexSignatures: true,
    });
    await writeFile(join(outputDirectory, `${parse(filename).name.replace(".schema", "")}.d.ts`), declaration);
  }
}

await generate();
