import type { CSSProperties } from "react";
import type { Cover } from "@/domain/element";

/** Paper is paper in both themes; it never follows the shadcn tokens. */
export const PAPER = "oklch(0.985 0.006 85)";

/** Inline SVG fractal noise, tiled as a background. Used at low opacity for grain. */
export function grainUrl(baseFrequency: number, seed = 3) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">` +
    `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="${baseFrequency}" numOctaves="3" seed="${seed}" stitchTiles="stitch"/>` +
    `<feColorMatrix type="saturate" values="0"/></filter>` +
    `<rect width="100%" height="100%" filter="url(#n)"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export const PAPER_GRAIN = grainUrl(0.9);

export const BOOK_SHADOW =
  "0 1px 2px rgb(0 0 0 / .08), 0 8px 24px rgb(0 0 0 / .12), 0 32px 64px -16px rgb(0 0 0 / .28)";

export const BOOK_SHADOW_LIFTED =
  "0 2px 4px rgb(0 0 0 / .08), 0 16px 32px rgb(0 0 0 / .14), 0 48px 80px -16px rgb(0 0 0 / .32)";

type Material = {
  base: CSSProperties;
  grain: { image: string; opacity: number; blend: CSSProperties["mixBlendMode"] };
};

const LINEN_GRAIN = grainUrl(1.2, 7);
const LEATHER_GRAIN = grainUrl(0.55, 11);
const CLOTH_GRAIN = grainUrl(1.6, 5);

/** Background, texture and edge treatment for a cover material. */
export function coverMaterial(cover: Cover): Material {
  switch (cover.material) {
    case "linen":
      return {
        base: {
          backgroundColor: `color-mix(in oklch, ${cover.color} 88%, oklch(0.62 0 0))`,
          backgroundImage: [
            "repeating-linear-gradient(0deg, rgb(255 255 255 / .05) 0 1px, transparent 1px 3px)",
            "repeating-linear-gradient(90deg, rgb(0 0 0 / .07) 0 1px, transparent 1px 3px)",
          ].join(","),
          boxShadow: "inset 0 0 0 1px rgb(255 255 255 / .06), inset 0 -2px 0 rgb(0 0 0 / .12)",
        },
        grain: { image: LINEN_GRAIN, opacity: 0.16, blend: "overlay" },
      };
    case "leather":
      return {
        base: {
          backgroundColor: cover.color,
          backgroundImage: [
            "radial-gradient(ellipse at 45% 35%, rgb(255 255 255 / .12), transparent 60%)",
            "radial-gradient(ellipse at 50% 50%, transparent 50%, rgb(0 0 0 / .38) 100%)",
          ].join(","),
          boxShadow: "inset 0 0 0 1px rgb(255 255 255 / .12), inset 0 -2px 0 rgb(0 0 0 / .25)",
        },
        grain: { image: LEATHER_GRAIN, opacity: 0.32, blend: "overlay" },
      };
    case "cloth":
      return {
        base: {
          backgroundColor: `color-mix(in oklch, ${cover.color} 94%, oklch(0.7 0 0))`,
          backgroundImage: [
            "repeating-linear-gradient(45deg, rgb(255 255 255 / .05) 0 1px, transparent 1px 4px)",
            "repeating-linear-gradient(-45deg, rgb(0 0 0 / .06) 0 1px, transparent 1px 4px)",
          ].join(","),
          boxShadow: "inset 0 0 0 1px rgb(255 255 255 / .05), inset 0 -2px 0 rgb(0 0 0 / .1)",
        },
        grain: { image: CLOTH_GRAIN, opacity: 0.12, blend: "soft-light" },
      };
  }
}

/** Inside of a cover: paper tinted by the cover colour. */
export function endpaperColor(cover: Cover) {
  return `color-mix(in oklch, ${cover.color} 14%, ${PAPER})`;
}

/** Light covers take dark ink; dark covers take a warm foil. Reads oklch lightness, defaults dark. */
export function isLightCover(cover: Cover) {
  const match = /oklch\(\s*([\d.]+)/.exec(cover.color);
  return match ? Number(match[1]) > 0.66 : false;
}
