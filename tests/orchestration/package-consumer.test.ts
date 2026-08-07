import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

/**
 * The package's own entry, resolved through `package.json`'s `exports` map — which is the surface this
 * file exists to check, so it is deliberately still the bare specifier rather than a `dist/` path.
 *
 * **It is held in a variable, and imported with `@vite-ignore`, so it is resolved when that line runs
 * rather than when Vite transforms this file.** A literal `import("@gwinnguyen/qa-skills")` is resolved by
 * `vite:import-analysis` during transform, before any test body executes: with a literal, the
 * `npm run build` below could not be what satisfies the import, and this file passed only when some
 * other test had already left a `dist/` behind. It did — `tests/cli/installed-cli.test.ts` ran its own
 * `npm run build` and happened to be ordered earlier — until that file was deleted, at which point a
 * clean CI runner had no `dist/` at transform time and this suite failed to collect at all.
 */
const packageEntry = "@gwinnguyen/qa-skills";

describe("compiled package consumer surface", () => {
  it("imports the public package entry and cannot reach the unsafe callback seam", async () => {
    await run("npm", ["run", "build"], { cwd: process.cwd() });
    // Typed as an unknown-valued record rather than through the package's own `.d.ts`: a deferred
    // specifier is `any` to the compiler, and the declarations it would otherwise pull in live under
    // `dist/`, which — being the very thing this test builds — is absent when `npm run typecheck` runs.
    // What survives compilation is exactly the check this test makes: which names exist at runtime.
    const consumer = await import(/* @vite-ignore */ packageEntry) as Readonly<Record<string, unknown>>;
    expect(consumer.createQaTester).toEqual(expect.any(Function));
    expect(consumer.selectRegressionCases).toEqual(expect.any(Function));
    expect("createUnsafeWorkflowRunnerForTests" in consumer).toBe(false);
  }, 60_000); // runs a full `npm run build` inside the test; the 5s default flakes under parallel load
});
