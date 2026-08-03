import { describe, expect, it } from "vitest";

import { isRuntimeCompatible, runtimeCompatibility } from "../../src/installer/manifest.js";

/** This function decides whether every installer command can run at all, and before Phase 10 no test
 *  called it directly — neither of its two gates was reached by any assertion. That is why moving the
 *  band to 1.x could break `runtime verify`, `skills install` and `readManifest` while the suite stayed
 *  green: every installer test USED TO resolve a fake binary printing `0.1.0` (see `runtime-fixture.ts`)
 *  — exactly the 0.x line the new band rejects. The same commit that moved this band also moved that
 *  default to `1.0.0`, so at HEAD the claim "every installer test resolves a binary printing 0.1.0" is
 *  no longer true. */
describe("isRuntimeCompatible", () => {
  it("accepts the 1.x line this build declares", () => {
    expect(isRuntimeCompatible("1.0.0")).toBe(true);
    expect(isRuntimeCompatible("1.4.2")).toBe(true);
    expect(isRuntimeCompatible("1.0.0-rc.1")).toBe(true);
  });

  it("rejects the superseded 0.x line", () => {
    expect(isRuntimeCompatible("0.3.0")).toBe(false);
    expect(isRuntimeCompatible("0.1.0")).toBe(false);
  });

  it("rejects the next major and strings that are not versions", () => {
    expect(isRuntimeCompatible("2.0.0")).toBe(false);
    expect(isRuntimeCompatible("nope")).toBe(false);
    expect(isRuntimeCompatible("")).toBe(false);
  });

  // The second gate: any range other than the literal one is rejected, INCLUDING a correct range.
  // This is pre-existing behaviour, not something Phase 10 added — but it had never been pinned.
  it("rejects every range other than the literal one, including a semantically correct range", () => {
    // Pin the VALUE of the band as its own assertion, separate from the `isRuntimeCompatible`
    // comparison below: if the line below derived its expected right-hand side from
    // `runtimeCompatibility`, changing that constant would change BOTH sides at once and no
    // assertion could ever go red.
    expect(runtimeCompatibility).toBe(">=1.0.0 <2.0.0");
    expect(isRuntimeCompatible("1.0.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(isRuntimeCompatible("1.0.0", "^1.0.0")).toBe(false);
    expect(isRuntimeCompatible("1.0.0", ">=0.1.0 <1.0.0")).toBe(false);
  });
});
