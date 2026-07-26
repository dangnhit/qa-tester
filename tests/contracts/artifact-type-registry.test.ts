import { describe, expect, it } from "vitest";

import artifactManifestSchema from "../../shared/schemas/artifact-manifest.schema.json" with { type: "json" };
import { schemas } from "../../src/contracts/catalog.js";
import { artifactTypes } from "../../src/contracts/types.js";

/** Four places must agree on the set of artifact types: the `artifactTypes` tuple
 *  (`src/contracts/types.ts`), the `schemas` map keys (`src/contracts/catalog.ts`), the manifest's
 *  `type` enum (`shared/schemas/artifact-manifest.schema.json`), and the generated
 *  `src/contracts/generated/*.d.ts` (covered separately by `npm run check:generated`). Nothing else
 *  asserted that the first three stay in lockstep: a type registered only in the tuple and the schema
 *  map but missing from the manifest enum is impossible to register (the manifest write would fail
 *  validation), and a type missing only from `schemas` is registrable but never validated. Neither
 *  failure mode is caught by exercising any single existing artifact type, since each type only
 *  incidentally proves its own row across the mirrors — it takes an explicit set-equality check to
 *  catch a mirror silently missing an entry for some *other* type. */
describe("artifact type registry mirrors", () => {
  const manifestTypeEnum = (
    artifactManifestSchema.properties.artifacts.items.properties.type as { enum: readonly string[] }
  ).enum;

  const mirrors: Record<string, ReadonlySet<string>> = {
    "src/contracts/types.ts artifactTypes tuple": new Set(artifactTypes),
    "src/contracts/catalog.ts schemas map keys": new Set(Object.keys(schemas)),
    "shared/schemas/artifact-manifest.schema.json type enum": new Set(manifestTypeEnum),
  };

  it("agree on the exact same set of artifact types", () => {
    const allTypes = new Set<string>();
    for (const set of Object.values(mirrors)) {
      for (const type of set) allTypes.add(type);
    }

    const problems: string[] = [];
    for (const type of allTypes) {
      const missingFrom = Object.entries(mirrors)
        .filter(([, set]) => !set.has(type))
        .map(([mirrorName]) => mirrorName);
      if (missingFrom.length > 0) {
        problems.push(`"${type}" is missing from: ${missingFrom.join(", ")}`);
      }
    }

    expect(problems).toEqual([]);
  });
});
