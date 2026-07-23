import type { CssBox } from "./redaction.js";

export type CaptureGeometry = { width: number; height: number; dpr: number; scrollX: number; scrollY: number; clip: CssBox };
export type CssAnnotation = { id: string; box: CssBox; label?: string; locator?: string };
export type PixelAnnotation = { id: string; x: number; y: number; width: number; height: number; label?: string; locator?: string; cssBox: CssBox };

function finiteNonNegative(value: number): boolean { return Number.isFinite(value) && value >= 0; }
function validBox(box: CssBox): boolean { return finiteNonNegative(box.x) && finiteNonNegative(box.y) && Number.isFinite(box.width) && Number.isFinite(box.height) && box.width > 0 && box.height > 0; }

/** Converts page-space CSS boxes into exact pixel coordinates for a clipped browser capture. */
export function normalizeGeometry(input: { image: CaptureGeometry; annotations: readonly CssAnnotation[] }): PixelAnnotation[] {
  const { image } = input;
  if (!Number.isFinite(image.dpr) || image.dpr <= 0 || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0 || !validBox(image.clip) || !finiteNonNegative(image.scrollX) || !finiteNonNegative(image.scrollY)) throw new Error("Invalid capture geometry");
  if (Math.round(image.clip.width * image.dpr) !== image.width || Math.round(image.clip.height * image.dpr) !== image.height) throw new Error("Capture geometry dimensions do not match clip and DPR");
  const clipPageX = image.scrollX + image.clip.x;
  const clipPageY = image.scrollY + image.clip.y;
  return input.annotations.map((annotation) => {
    if (!annotation.id || !validBox(annotation.box)) throw new Error("Invalid annotation geometry");
    const { box } = annotation;
    if (box.x < clipPageX || box.y < clipPageY || box.x + box.width > clipPageX + image.clip.width || box.y + box.height > clipPageY + image.clip.height) throw new Error("Annotation is outside capture bounds");
    const x = Math.round((box.x - clipPageX) * image.dpr);
    const y = Math.round((box.y - clipPageY) * image.dpr);
    const width = Math.round(box.width * image.dpr);
    const height = Math.round(box.height * image.dpr);
    if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > image.width || y + height > image.height) throw new Error("Normalized annotation is outside image bounds");
    return { id: annotation.id, x, y, width, height, ...(annotation.label === undefined ? {} : { label: annotation.label.slice(0, 120) }), ...(annotation.locator === undefined ? {} : { locator: annotation.locator }), cssBox: { ...box } };
  });
}
