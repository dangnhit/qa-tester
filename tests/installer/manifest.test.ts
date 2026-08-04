import { describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { runtimeVersion } from "../../src/installer/manifest.js";

/** `runtimeVersion` (`src/installer/manifest.ts`) is this build's own version. It backs the
 *  CLI's `--version` output, the `runtime verify` report, and the `sourceVersion` stamped
 *  into every installed skill manifest — so it must track `package.json`'s `version` field.
 *  (This is NOT independent of `runtimeCompatibility`: `createManifest`'s default `sourceVersion`
 *  falls back to `runtimeVersion` and is checked with `isRuntimeCompatible` against the current
 *  `runtimeCompatibility` band. The v1.0 contract freeze widened that range from `0.1.0`-`0.3.0`'s
 *  home to `>=1.0.0 <2.0.0` in the same change that bumped `runtimeVersion` to `1.0.0` — the two
 *  had to move together, or this build would have rejected its own version.) Nothing else asserts
 *  `runtimeVersion` and `package.json`'s `version` stay in lockstep: each looks correct in
 *  isolation, so a bump to one without the other silently ships a build that misreports its own
 *  version. */
describe("runtime version tracks package.json", () => {
  it("keeps manifest.ts runtimeVersion equal to package.json's version", () => {
    expect(
      runtimeVersion,
      `runtimeVersion ("${runtimeVersion}") in src/installer/manifest.ts has drifted from package.json's "version" ("${packageJson.version}"); update runtimeVersion to match`,
    ).toBe(packageJson.version);
  });
});
