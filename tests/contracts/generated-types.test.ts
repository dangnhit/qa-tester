import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("generated contract types", () => {
  it("generates run metadata as a closed lifecycle and mode discriminated union", async () => {
    const declaration = await readFile(new URL("../../src/contracts/generated/run-metadata.d.ts", import.meta.url), "utf8");

    expect(declaration).not.toContain("[k: string]");
    expect(declaration).toContain("finalizedProfile?: never");
    expect(declaration).toContain("name: M");
  });
});
