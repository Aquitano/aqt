import { useId, type CSSProperties } from "react";

import { centre, serif } from "../brand";

/**
 * How the words are set into one shot, so they read as if they were in the photograph: on its own
 * edge, in its light and tonal range, at its focus and with its grain.
 */
export type Lettering = {
  /** The line the word stands above, in px below the centre line, every 80 px from x = 0 to x = 1920. */
  edge: readonly number[];
  /** The ink, or the scene's light falling across the word: `angle` 0 runs left to right, 90 top to bottom. */
  ink: string | { from: string; to: string; angle: number };
  /** Extra room between the word and its line, in ems, where the ground would crowd it. */
  lift?: number;
  /** Gaussian blur matching the photo's own sharpness, in px. */
  focus: number;
  /** The photo's own grain, as the standard deviation of its noise on a 0-1 scale. */
  grain: number;
  /** The scene's light bleeding over the letters' edges, as it does round anything in front of it. */
  wrap?: { color: string; strength: number };
  /** Light spilling round the letters, such as film halation. */
  glow?: { color: string; radius: number };
  blend?: CSSProperties["mixBlendMode"];
  opacity?: number;
};

/** Between the serif's text and display cuts: sturdy like printed type, without its blunt serifs. */
const set: CSSProperties = {
  ...serif,
  fontOpticalSizing: "none",
  fontVariationSettings: '"opsz" 30',
  letterSpacing: "0em",
  /* One weight throughout, so the letters keep their widths and places from shot to shot. */
  fontWeight: 580,
};

const step = 80;

/**
 * A smooth path through the measured edge (Catmull-Rom as cubic Béziers), raised by `gap`, held
 * level past both sides of the frame so long words never run off its ends.
 */
const along = (edge: readonly number[], gap: number, scale = 1) => {
  const points = edge.map(
    (offset, i) => [i * step * scale, (centre.y + offset - gap) * scale] as const,
  );
  const first = points[0] ?? [0, centre.y * scale];
  const last = points.at(-1) ?? [1920 * scale, centre.y * scale];
  const all = [[-400 * scale, first[1]] as const, ...points, [2320 * scale, last[1]] as const];
  const at = (i: number) => all[Math.min(all.length - 1, Math.max(0, i))] ?? first;
  let d = `M ${all[0]?.[0]} ${all[0]?.[1]}`;
  for (let i = 0; i < all.length - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p2[0]} ${p2[1]}`;
  }
  return d;
};

/**
 * Turns the measured grain into the noise amount the filter adds: fractalNoise here spreads about
 * 0.12 around 0.5, and the measured grain (a blurred difference) reads about 2.5 times low, as
 * checked against the strokes and the sky of rendered frames.
 */
const grainGain = 2.5 / 0.12;

/**
 * How far above its line a word's baseline sits, in ems: just under the depth of the serif's
 * descenders (0.22), so a y stays whole and its tail comes down to the edge.
 */
const clearance = 0.2;

/**
 * The words are set four times larger and drawn at a quarter size. Above about 256 px the browser
 * draws glyphs as outlines instead of pixel-snapped bitmaps, so letters keep their exact
 * places instead of each jumping to the nearest pixel.
 */
const outline = 4;

/** Words set into the shot under them, standing just above its edge. */
export function Lettered({
  text,
  size,
  opacity,
  lettering,
}: {
  text: string;
  size: number;
  opacity: number;
  lettering: Lettering;
}) {
  const id = useId().replaceAll(/\W/g, "");
  const { ink, wrap, glow } = lettering;
  const amount = lettering.grain * grainGain;
  const radians = typeof ink === "string" ? 0 : (ink.angle * Math.PI) / 180;
  return (
    <svg
      width={1920}
      height={1080}
      style={{
        position: "absolute",
        inset: 0,
        opacity: opacity * (lettering.opacity ?? 1),
        mixBlendMode: lettering.blend,
        filter: "url(#grade)",
      }}
    >
      <defs>
        <path
          id={`edge${id}`}
          d={along(lettering.edge, size * (clearance + (lettering.lift ?? 0)), outline)}
        />
        {typeof ink === "string" ? null : (
          <linearGradient
            id={`ink${id}`}
            x1={0.5 - 0.5 * Math.cos(radians)}
            y1={0.5 - 0.5 * Math.sin(radians)}
            x2={0.5 + 0.5 * Math.cos(radians)}
            y2={0.5 + 0.5 * Math.sin(radians)}
          >
            <stop offset="0%" stopColor={ink.from} />
            <stop offset="100%" stopColor={ink.to} />
          </linearGradient>
        )}
        <filter
          id={`film${id}`}
          x="-5%"
          y="-40%"
          width="110%"
          height="180%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation={lettering.focus} result="soft" />
          {wrap ? (
            <>
              <feGaussianBlur in="SourceAlpha" stdDeviation={size * 0.05} result="spread" />
              <feComposite
                in="SourceAlpha"
                in2="spread"
                operator="arithmetic"
                k2={1}
                k3={-1}
                result="rim"
              />
              <feFlood floodColor={wrap.color} floodOpacity={wrap.strength} />
              <feComposite in2="rim" operator="in" />
              <feGaussianBlur stdDeviation={lettering.focus} result="light" />
              <feBlend in="light" in2="soft" mode="screen" result="lit" />
            </>
          ) : (
            <feOffset in="soft" result="lit" />
          )}
          <feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves={1} seed={7} />
          <feColorMatrix
            type="matrix"
            values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 0 1"
            result="noise"
          />
          <feComposite
            in="lit"
            in2="noise"
            operator="arithmetic"
            k1={0}
            k2={1}
            k3={amount}
            k4={-amount / 2}
            result="grained"
          />
          <feComposite in="grained" in2="soft" operator="in" />
        </filter>
      </defs>
      <g style={glow ? { filter: `drop-shadow(0 0 ${glow.radius}px ${glow.color})` } : undefined}>
        <g filter={`url(#film${id})`}>
          <text
            transform={`scale(${1 / outline})`}
            fill={typeof ink === "string" ? ink : `url(#ink${id})`}
            fontSize={size * outline}
            style={{ ...set, textRendering: "geometricPrecision" }}
          >
            <textPath href={`#edge${id}`} startOffset="50%" textAnchor="middle">
              {text}
            </textPath>
          </text>
        </g>
      </g>
    </svg>
  );
}
