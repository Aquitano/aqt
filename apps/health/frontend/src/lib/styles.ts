import type { CSSProperties } from "react";

/** React's `CSSProperties` has no slot for CSS custom properties, so components that set one widen it. */
export type CustomPropertyStyle = CSSProperties & Record<`--${string}`, string | number>;

/** Staggers a card's reveal animation; the stylesheets read `--reveal-i` as the delay multiplier. */
export function revealStyle(index: number): CustomPropertyStyle {
  return { "--reveal-i": index };
}
