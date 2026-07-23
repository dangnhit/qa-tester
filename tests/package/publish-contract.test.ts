import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("publish contract", () => {
  it("publishes typed runtime and CLI exports without compiling development sources", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      private?: boolean;
      types?: string;
      exports?: Record<string, string | { types?: string; import?: string }>;
      scripts?: Record<string, string>;
    };
    const buildConfig = JSON.parse(await readFile(new URL("../../tsconfig.build.json", import.meta.url), "utf8")) as {
      compilerOptions?: { declaration?: boolean };
      include?: string[];
      exclude?: string[];
    };

    expect(packageJson.private).not.toBe(true);
    expect(packageJson.types).toMatch(/\.d\.ts$/);
    expect(packageJson.exports?.["."]).toEqual(expect.objectContaining({
      types: expect.stringMatching(/\.d\.ts$/),
      import: expect.stringMatching(/\.js$/),
    }));
    expect(packageJson.scripts?.build).toContain("tsconfig.build.json");
    expect(buildConfig.compilerOptions?.declaration).toBe(true);
    expect(buildConfig.include).toEqual(["src/**/*.ts"]);
    expect(buildConfig.exclude).toEqual(expect.arrayContaining(["tests", "fixtures", "scripts"]));
  });
});
