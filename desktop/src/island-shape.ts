// Outline of the island: a circle (or pill) hanging from the top screen edge. Left and right a concave quarter arc
// leaves the edge tangentially and meets the circle at its leftmost and rightmost point, where the circle runs
// vertically. The arc's height is fixed by the circle centre; its width is free, so the arc is elliptical.

export type IslandGeometry = {
  /** Horizontal centre. */ cx: number;
  /** Gap between the screen edge and the top of the circle (negative: the edge cuts into the circle). */ top: number;
  /** Width; equal to the height for a circle. */ w: number;
  h: number;
  /** Width of the side arcs. */ fillet: number;
};

const n = (value: number) => Math.round(value * 100) / 100;

/** SVG path, closed above the screen edge (y < 0) so the shape blends into it. Empty when there is nothing to draw. */
export function islandPath({ cx, top, w, h, fillet }: IslandGeometry): string {
  if (!(h >= 1)) return "";
  const r = h / 2, width = Math.max(w, h), f = Math.max(fillet, 0);
  const cy = Math.max(top + r, 1), bottom = cy + r;
  const capLeft = cx - width / 2 + r, capRight = cx + width / 2 - r;
  const left = capLeft - r, right = capRight + r;
  return [
    `M${n(left - f)},-2`, `L${n(left - f)},0`,
    `A${n(f)},${n(cy)} 0 0 1 ${n(left)},${n(cy)}`,
    `A${n(r)},${n(r)} 0 0 0 ${n(capLeft)},${n(bottom)}`,
    `L${n(capRight)},${n(bottom)}`,
    `A${n(r)},${n(r)} 0 0 0 ${n(right)},${n(cy)}`,
    `A${n(f)},${n(cy)} 0 0 1 ${n(right + f)},0`,
    `L${n(right + f)},-2`, "Z",
  ].join("");
}

/** Width the island occupies at the screen edge, arcs included. */
export const islandFootprint = ({ w, h, fillet }: IslandGeometry) => Math.max(w, h) + 2 * Math.max(fillet, 0);

export type IslandShapeKind = "hidden" | "idle" | "usage" | "notice";
/** Sizes in DIP. Gap 2 px and arc width 15 px were chosen in the mock-up (ai-usage-app #61). */
export const ISLAND_SIZES: Record<IslandShapeKind, { w: number; h: number; fillet: number; top: number }> = {
  hidden: { w: 0, h: 0, fillet: 0, top: 0 },
  idle: { w: 30, h: 30, fillet: 15, top: 2 },
  usage: { w: 300, h: 50, fillet: 19, top: 2 },
  notice: { w: 236, h: 36, fillet: 16, top: 2 },
};

/** Screen points (DIP) left and right of the widest pill, just below the top edge of `display`. */
export function samplePoints(display: { bounds: { x: number; y: number; width: number } }): { x: number; y: number }[] {
  const centre = display.bounds.x + display.bounds.width / 2;
  const half = islandFootprint({ cx: 0, ...ISLAND_SIZES.usage }) / 2;
  return [half + 24, half + 90].flatMap(dx => [3, 14].flatMap(dy => [{ x: centre - dx, y: display.bounds.y + dy }, { x: centre + dx, y: display.bounds.y + dy }]));
}

