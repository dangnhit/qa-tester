import { describe, expect, it } from "vitest";

import { createEntityId, createRunId } from "../../src/core/ids.js";
import { utcNow } from "../../src/core/time.js";

describe("identifier and time helpers", () => {
  it("creates UTC run IDs with a cryptographic lowercase hexadecimal suffix", () => {
    expect(createRunId(new Date("2026-07-23T12:34:56Z"))).toMatch(
      /^20260723T123456Z-[0-9a-f]{6}$/,
    );
  });

  it("creates time-sortable ULID entity identifiers", () => {
    expect(createEntityId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("formats injected clocks as UTC ISO timestamps", () => {
    expect(utcNow(() => new Date("2026-07-23T12:34:56Z"))).toBe("2026-07-23T12:34:56.000Z");
  });
});
