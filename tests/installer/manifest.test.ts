import { describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { runtimeVersion } from "../../src/installer/manifest.js";

/** `runtimeVersion` (`src/installer/manifest.ts`) is this build's own version. It backs the
 *  CLI's `--version` output, the `runtime verify` report, and the `sourceVersion` stamped
 *  into every installed skill manifest — so it must track `package.json`'s `version` field.
 *  (This is independent of `runtimeCompatibility`, the wide pre-1.0 compatibility band, which
 *  does not change when this build's own version is bumped.) Nothing else asserts these two
 *  values stay in lockstep: each looks correct in isolation, so a bump to one without the
 *  other silently ships a build that misreports its own version. */
describe("runtime version tracks package.json", () => {
  it("keeps manifest.ts runtimeVersion equal to package.json's version", () => {
    expect(
      runtimeVersion,
      `runtimeVersion ("${runtimeVersion}") in src/installer/manifest.ts has drifted from package.json's "version" ("${packageJson.version}"); update runtimeVersion to match`,
    ).toBe(packageJson.version);
  });
});
