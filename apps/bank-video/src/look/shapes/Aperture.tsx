import { Audio } from "@remotion/media";
import { AbsoluteFill, staticFile, useCurrentFrame } from "remotion";

import { color, display, mono, serif } from "../../brand";
import { Grain } from "../../Frame";
import { easeIn, inOut, mix, ramp } from "../../motion";
import { record } from "../../records";
import { bar, beat } from "../../timeline";
import { Grade, PhotoShot } from "../Photo";
import { at, motif } from "../plan";
import { photoOf, sharedCuts } from "../versions";

/** Every image is seen through one aperture that never moves, as an eyepiece or a slide frames it. */
export type Aperture = { width: number; height: number; radius: number };

export const apertures = {
  square: { width: 720, height: 720, radius: 0 },
  lens: { width: 780, height: 780, radius: 390 },
  slit: { width: 1920, height: 420, radius: 0 },
} satisfies Record<string, Aperture>;

export type ApertureName = keyof typeof apertures;

/** The aperture's centre. The photograph's line runs through it, and the words sit below it. */
const middle = { x: 960, y: 455 };

/** The calm image after the cut: in a round or square window it reads as a sun on the horizon. */
const calm = "atlantic";

/** The test starts three bars before the cut and ends once the name and tagline have settled. */
export const testFrom = at.aha - 3 * bar;
export const testDuration = motif[2] + 96 - testFrom;

const words = ["Every", "answer", "has a", "source."].map((text, i) => ({
  text,
  from: at.aha - bar + i * beat,
}));

/** The mark's unit, so its visible 23 units are 120 px tall. */
const unit = 120 / 23;

const clip = (w: number, h: number, r: number) => {
  const top = middle.y - h / 2;
  const left = middle.x - w / 2;
  return `inset(${top}px ${1920 - left - w}px ${1080 - top - h}px ${left}px round ${r}px)`;
};

function Caption({
  text,
  y,
  size = 64,
  opacity = 1,
}: {
  text: string;
  y: number;
  size?: number;
  opacity?: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: y,
        textAlign: "center",
        ...serif,
        fontSize: size,
        lineHeight: 1,
        color: "#f4f0e6",
        opacity,
      }}
    >
      {text}
    </div>
  );
}

export function ApertureFilm({ aperture }: { aperture: ApertureName }) {
  const now = testFrom + useCurrentFrame();
  const base = apertures[aperture];
  const cut = sharedCuts.find((c) => now >= c.from && now < c.from + c.duration);
  const photo = photoOf(now >= at.aha ? calm : (cut?.photo ?? calm));
  const push = cut ? (now - cut.from) / cut.duration : 0;

  const close = ramp(now, motif[2], motif[2] + 22, easeIn);
  const square = 6 * unit;
  const w = mix(base.width, square, close);
  const h = mix(base.height, square, close);
  const r = mix(base.radius, 0, close);
  const ink = ramp(now, motif[2] + 12, motif[2] + 22);
  const corners = ramp(now, motif[2] + 16, motif[2] + 34, inOut);
  const name = ramp(now, motif[2] + 30, motif[2] + 50);
  const tagline = ramp(now, motif[2] + 58, motif[2] + 80);

  const below = middle.y + base.height / 2;
  const word = now < at.aha ? words.findLast((item) => now >= item.from) : undefined;
  const answer = record("answer");
  const release = 1 - ramp(now, motif[1], motif[1] + 16);
  const glow = (1 - close) * 0.5;
  const halo = `radial-gradient(${w * 0.5 + 40}px ${h * 0.5 + 40}px at ${middle.x}px ${middle.y}px, black 70%, transparent 100%)`;

  return (
    <AbsoluteFill style={{ background: "#080807" }}>
      <Grade />
      <AbsoluteFill style={{ opacity: glow, maskImage: halo, WebkitMaskImage: halo }}>
        <AbsoluteFill style={{ filter: "blur(36px)" }}>
          <PhotoShot photo={photo} push={push} y={middle.y} />
        </AbsoluteFill>
      </AbsoluteFill>
      <AbsoluteFill style={{ clipPath: clip(w, h, r) }}>
        <PhotoShot photo={photo} push={push} y={middle.y} />
        <AbsoluteFill
          style={{
            background: `radial-gradient(${w * 0.75}px ${h * 0.75}px at ${middle.x}px ${middle.y}px, transparent 55%, rgb(0 0 0 / 0.35))`,
          }}
        />
        <AbsoluteFill style={{ background: color.ink, opacity: ink }} />
      </AbsoluteFill>

      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, opacity: corners }}>
        <g transform={`translate(${middle.x - 16 * unit} ${middle.y - 16 * unit}) scale(${unit})`}>
          <path d="M6 14V6h8M26 18v8h-8" stroke={color.ink} strokeWidth={3} fill="none" />
        </g>
      </svg>

      {word ? <Caption text={word.text} y={below + 70} /> : null}
      {now >= at.aha ? (
        <>
          <Caption text={answer.text} y={below + 66} size={50} opacity={release} />
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: below + 136,
              textAlign: "center",
              ...mono,
              fontSize: 20,
              color: "#e9e4d6",
              opacity: release * 0.8,
            }}
          >
            Gmail · {answer.ref}
          </div>
        </>
      ) : null}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: middle.y + 11.5 * unit + 46,
          textAlign: "center",
          ...display,
          fontSize: 120,
          lineHeight: 1,
          color: "#f4f0e6",
          opacity: name,
          transform: `translateY(${mix(10, 0, name)}px)`,
        }}
      >
        siglum
      </div>
      <Caption
        text="Search what you wrote, received and saved."
        y={middle.y + 11.5 * unit + 200}
        size={38}
        opacity={tagline * 0.85}
      />
      <Grain />
      <Audio src={staticFile("score-line.wav")} trimBefore={testFrom} />
    </AbsoluteFill>
  );
}
