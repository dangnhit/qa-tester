import { describe, expect, it } from "vitest";

import { normalizeGeometry } from "../../src/evidence/geometry.js";

describe("normalizeGeometry", () => {
  it("converts CSS page coordinates to clipped screenshot pixels using DPR and scroll origin", () => {
    expect(normalizeGeometry({
      image: { width: 400, height: 300, dpr: 2, scrollX: 100, scrollY: 200, clip: { x: 50, y: 50, width: 200, height: 150 } },
      annotations: [{ id: "field", box: { x: 175, y: 275, width: 50, height: 25 }, label: "Required" }],
    })).toEqual([{ id: "field", x: 50, y: 50, width: 100, height: 50, label: "Required", cssBox: { x: 175, y: 275, width: 50, height: 25 } }]);
  });

  it("rejects invalid and out-of-bounds annotations rather than clipping a misleading box", () => {
    const image = { width: 400, height: 300, dpr: 2, scrollX: 0, scrollY: 0, clip: { x: 0, y: 0, width: 200, height: 150 } };
    expect(() => normalizeGeometry({ image, annotations: [{ id: "bad", box: { x: -1, y: 0, width: 10, height: 10 } }] })).toThrow(/bounds|invalid/i);
    expect(() => normalizeGeometry({ image, annotations: [{ id: "bad", box: { x: 190, y: 0, width: 20, height: 10 } }] })).toThrow(/bounds|invalid/i);
  });
});
