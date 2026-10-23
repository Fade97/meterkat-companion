// Outline of the island: a circle (or pill, or rounded panel) hanging from the top screen edge. Left and right a concave quarter arc
// leaves the edge tangentially and meets the circle at its leftmost and rightmost point, where the circle runs
// vertically. The arc's height is fixed by the circle centre; its width is free, so the arc is elliptical.

export type IslandGeometry = {
  /** Horizontal centre. */ cx: number;
  /** Gap between the screen edge and the top of the circle (negative: the edge cuts into the circle). */ top: number;
  /** Width; equal to the height for a circle. */ w: number;
  h: number;
  /** Width of the side arcs. */ fillet: number;
  /** Corner radius, at most h / 2 (the default: a circle or pill). Smaller for the panel. */ radius?: number;
};

const n = (value: number) => Math.round(value * 100) / 100;

/** SVG path, closed above the screen edge (y < 0) so the shape blends into it. Empty when there is nothing to draw. */
export function islandPath({ cx, top, w, h, fillet, radius }: IslandGeometry): string {
  if (!(h >= 1)) return "";
  const r = Math.max(Math.min(radius ?? h / 2, h / 2), 0.5), width = Math.max(w, 2 * r), f = Math.max(fillet, 0);
  // cy: centre of the upper corners, where the side arcs end; low: centre of the lower corners.
  const cy = Math.max(top + r, 1), bottom = Math.max(top + h, cy + r), low = bottom - r;
  const capLeft = cx - width / 2 + r, capRight = cx + width / 2 - r;
  const left = capLeft - r, right = capRight + r;
  const sides = low - cy > 0.005;
  return [
    `M${n(left - f)},-2`, `L${n(left - f)},0`,
    `A${n(f)},${n(cy)} 0 0 1 ${n(left)},${n(cy)}`,
    sides ? `L${n(left)},${n(low)}` : "",
    `A${n(r)},${n(r)} 0 0 0 ${n(capLeft)},${n(bottom)}`,
    `L${n(capRight)},${n(bottom)}`,
    `A${n(r)},${n(r)} 0 0 0 ${n(right)},${n(low)}`,
    sides ? `L${n(right)},${n(cy)}` : "",
    `A${n(f)},${n(cy)} 0 0 1 ${n(right + f)},0`,
    `L${n(right + f)},-2`, "Z",
  ].join("");
}

/** Width the island occupies at the screen edge, arcs included. */
export const islandFootprint = ({ w, h, fillet, radius }: IslandGeometry) => Math.max(w, 2 * Math.min(radius ?? h / 2, h / 2)) + 2 * Math.max(fillet, 0);

export type IslandShapeKind = "hidden" | "idle" | "hover" | "usage" | "notice" | "panel";
/**
 * Sizes in DIP. Gap 2 px and arc width 15 px were chosen in the mock-up (ai-usage-app #61). The panel's height
 * follows its content (at most PANEL_MAX_HEIGHT); `h` here is only its starting value.
 */
export const ISLAND_SIZES: Record<IslandShapeKind, { w: number; h: number; fillet: number; top: number; radius?: number }> = {
  hidden: { w: 0, h: 0, fillet: 0, top: 0 },
  idle: { w: 30, h: 30, fillet: 15, top: 2 },
  hover: { w: 34, h: 34, fillet: 16, top: 2 },
  usage: { w: 300, h: 50, fillet: 19, top: 2 },
  notice: { w: 236, h: 36, fillet: 16, top: 2 },
  panel: { w: 380, h: 120, fillet: 19, top: 2, radius: 22 },
};
/** Also the panel's max-height in island.css. */
export const PANEL_MAX_HEIGHT = 520;

/** A rectangle in window coordinates (DIP) where the island takes the pointer. */
export type HitArea = { x: number; y: number; width: number; height: number };
/** True when the screen point lies in `area` of a window at `bounds`. */
export function hits(bounds: { x: number; y: number }, area: HitArea | null, point: { x: number; y: number }) {
  if (!area) return false;
  const x = point.x - bounds.x, y = point.y - bounds.y;
  return x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height;
}

/** Screen points (DIP) left and right of the widest shape, just below the top edge of `display`. */
export function samplePoints(display: { bounds: { x: number; y: number; width: number } }): { x: number; y: number }[] {
  const centre = display.bounds.x + display.bounds.width / 2;
  const half = islandFootprint({ cx: 0, ...ISLAND_SIZES.panel }) / 2;
  return [half + 24, half + 90].flatMap(dx => [3, 14].flatMap(dy => [{ x: centre - dx, y: display.bounds.y + dy }, { x: centre + dx, y: display.bounds.y + dy }]));
}

