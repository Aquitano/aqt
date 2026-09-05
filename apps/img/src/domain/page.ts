/** Every page is a PAGE_UNITS x PAGE_UNITS square, independent of screen size. */
export const PAGE_UNITS = 1000;

/** Multiplier that turns page units into CSS pixels for a page rendered at `pagePx`. */
export function pageScale(pagePx: number) {
  return pagePx / PAGE_UNITS;
}
