import { describe, expect, it } from "vitest";

import { parseAuthoringDocument } from "../../src/contracts/authoring.js";

describe("parseAuthoringDocument", () => {
  it("parses an object-shaped YAML authoring document", () => {
    expect(parseAuthoringDocument("mode: full", "yaml")).toEqual({ mode: "full" });
  });

  it("rejects non-object roots and YAML multi-document input", () => {
    expect(() => parseAuthoringDocument("[]", "json")).toThrow(/object/i);
    expect(() => parseAuthoringDocument("mode: full\n---\nmode: plan", "yaml")).toThrow(
      /multi-document/i,
    );
  });
});
