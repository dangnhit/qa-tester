import { describe, expect, it } from "vitest";

import { classifyUserStatement } from "../../src/planning/authority.js";

describe("classifyUserStatement", () => {
  it("treats explicit expected behavior as authoritative", () => {
    expect(classifyUserStatement({ text: "Users must see a confirmation after saving.", source: "user" }))
      .toBe("AUTHORITATIVE");
  });

  it("treats tentative user wording as assumed", () => {
    expect(classifyUserStatement({ text: "I think the dialog might close after saving.", source: "user" }))
      .toBe("ASSUMED");
  });

  it("treats observed code behavior as inferred", () => {
    expect(classifyUserStatement({ text: "The current controller redirects to /home.", source: "code" }))
      .toBe("INFERRED");
  });

  it("makes incompatible authoritative statements conflicting", () => {
    expect(classifyUserStatement({
      text: "Users must remain on the form after saving.",
      source: "user",
      conflictsWith: [{ text: "Users must be redirected after saving.", authority: "AUTHORITATIVE" }],
    })).toBe("CONFLICTING");
  });
});
