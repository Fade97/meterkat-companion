// Keyboard for segmented controls, the ARIA radio-group pattern: arrows move the selection and wrap, Home/End jump.
// Pure, so it is unit-tested; app.ts moves focus and selects.

/** The radio to select after `key` in a group of `count` with `index` selected; null for keys the group ignores. */
export function radioStep(index: number, count: number, key: string): number | null {
  if (count < 1) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
