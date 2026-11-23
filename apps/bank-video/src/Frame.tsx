import type { CSSProperties } from "react";
import { useCurrentFrame } from "remotion";

import { centre, color, frame, kindColor, mono } from "./brand";
import { easeIn, inOut, mix, ramp } from "./motion";
import { hex, mulberry, totalRecords } from "./records";
import { at, beat, cuts, fps, hasStamp, motif, scaleOf, type Cut, type Scale } from "./timeline";

/**
 * Where the bracket ends up: the favicon's mark, scaled so one unit of its 32-unit grid is 6px.
 * It forms on the centre line, where the answer was, then rises to make room for the name.
 */
export const logo = { x: centre.x, rest: 470, unit: 6 } as const;

export const logoY = (f: number) =>
  mix(centre.y, logo.rest, ramp(f, motif[2] + 12, motif[2] + 48, inOut));

/** A soft flash of light on each note of the solo motif. */
const ring = (f: number) =>
  motif.reduce((sum, note) => sum + (f >= note ? Math.exp(-(f - note) / 9) : 0), 0);

const pulse = (f: number) => {
  if (f < at.pattern || f >= at.aha) return 0;
  return Math.exp(-((f - at.pattern) % beat) / 4);
};

/** The invariant: two opposite corners, fixed in every shot, that close into the logo at the end. */
export function Bracket() {
  const f = useCurrentFrame();
  const intro = ramp(f, 6, 40, inOut);
  const morph = ramp(f, motif[1], motif[1] + 30, inOut);
  const square = ramp(f, motif[2], motif[2] + 9, (x) => 1 - (1 - x) ** 3);
  const u = logo.unit;
  const y = logoY(f);
  const box = {
    left: mix(frame.left, logo.x - 10 * u, morph),
    top: mix(frame.top, y - 10 * u, morph),
    right: mix(frame.right, logo.x + 10 * u, morph),
    bottom: mix(frame.bottom, y + 10 * u, morph),
  };
  const arm = mix(frame.arm * intro, 8 * u, morph);
  const stroke = mix(2, 3 * u, morph);
  const build = f >= at.cascade && f < at.aha ? ramp(f, at.cascade, at.aha, easeIn) : 0;
  const bloom = 3 + build * 9 + pulse(f) * 3 + ring(f) * 7;
  const side = mix(14, 6 * u, square);
  const round = mix(7, 0, square);
  return (
    <svg
      width={1920}
      height={1080}
      style={{
        position: "absolute",
        inset: 0,
        opacity: intro,
        filter: `drop-shadow(0 0 ${bloom}px rgb(236 232 220 / ${0.5 + build * 0.3}))`,
      }}
    >
      <path
        d={`M${box.left} ${box.top + arm} V${box.top} H${box.left + arm} M${box.right} ${box.bottom - arm} V${box.bottom} H${box.right - arm}`}
        fill="none"
        stroke={color.ink}
        strokeWidth={stroke}
      />
      {f >= at.aha ? (
        <rect
          x={logo.x - side / 2}
          y={y - side / 2}
          width={side}
          height={side}
          rx={round}
          fill={color.ink}
        />
      ) : null}
    </svg>
  );
}

/** Hairlines along the centre line, like the reticle of an instrument. */
export function Axis() {
  const f = useCurrentFrame();
  const opacity = ramp(f, 14, 50) * (1 - ramp(f, motif[1], motif[1] + 12));
  const ticks = Array.from({ length: 20 }, (_, i) => i);
  const side = (from: number, dir: 1 | -1) => (
    <g>
      <line
        x1={from}
        x2={from + dir * 456}
        y1={centre.y}
        y2={centre.y}
        stroke={color.rule}
        strokeWidth={1}
      />
      {ticks.map((i) => (
        <line
          key={i}
          x1={from + dir * i * 24}
          x2={from + dir * i * 24}
          y1={centre.y - (i % 5 === 0 ? 7 : 3)}
          y2={centre.y + (i % 5 === 0 ? 7 : 3)}
          stroke={color.rule}
          strokeWidth={1}
        />
      ))}
    </g>
  );
  return (
    <svg
      width={1920}
      height={1080}
      style={{ position: "absolute", inset: 0, opacity: opacity * 0.6 }}
    >
      {side(frame.left - 40, -1)}
      {side(frame.right + 40, 1)}
    </svg>
  );
}

const current = (f: number): [Cut, number] => {
  const index = cuts.findIndex((c) => f >= c.from && f < c.from + c.duration);
  const cut = cuts[index] ?? cuts[cuts.length - 1] ?? cuts[0];
  if (!cut) throw new Error("the timeline has no cuts");
  return [cut, Math.max(index, 0)];
};

const spanName = {
  day: "one day",
  month: "one month",
  year: "one year",
  decade: "eleven years",
} as const;

const describe = (cut: Cut) => {
  const shot = cut.shot;
  switch (shot.type) {
    case "caret":
      return { label: "observation", note: "" };
    case "record":
      return {
        label: `record · ${shot.entry.kind} · ${shot.entry.source.toLowerCase()}`,
        note: `${shot.entry.date}  ${shot.entry.time}`,
      };
    case "scan":
      return { label: "record · drives · scan", note: `${shot.entry.date}  ${shot.entry.time}` };
    case "query":
      return { label: "instrument · search", note: "" };
    case "derive":
      return { label: "instrument · ref", note: "same record, same ref, every rebuild" };
    case "resolve":
      return { label: "instrument · resolve", note: "one ref, every copy" };
    case "count":
      return { label: "instrument · import", note: "import twice, store once" };
    case "contact":
      return { label: "instrument · contacts", note: "one person, many identities" };
    case "day":
      return { label: "archive · one day", note: "2024-02-26" };
    case "sources":
      return { label: "archive · sources", note: "mail, chats, AI, watch history, drives" };
    case "field":
      return {
        label: `archive · ${spanName[shot.span]}`,
        note: shot.span === "decade" ? "2014 to 2025" : "2024",
      };
    case "plate":
      return { label: "archive · every day", note: "2014 to 2025" };
    case "answer":
      return { label: "", note: "" };
    default:
      return shot satisfies never;
  }
};

const stampOf = (cut: Cut) => {
  const shot = cut.shot;
  if (hasStamp(shot) && "entry" in shot) return shot.entry;
  return undefined;
};

const readout: CSSProperties = {
  ...mono,
  position: "absolute",
  fontSize: 16,
  color: color.faint,
  letterSpacing: "0.02em",
};

/** A ref that rolls through random digits for a few frames before it settles, like a counter. */
function Stamp({ cut, f }: { cut: Cut; f: number }) {
  const entry = stampOf(cut);
  if (!entry) return null;
  const since = f - (cut.from + cut.stamp);
  if (since < 0) return null;
  const [kind = "", value = ""] = entry.ref.split(":");
  const jitter = mulberry(f * 7919 + 13);
  const shown =
    since >= 4 || cut.stamp === 0
      ? value
      : value
          .split("")
          .map((c, i) => (i < since * 4 ? c : hex(jitter, 1)))
          .join("");
  const tint = kindColor[entry.kind];
  return (
    <div
      style={{
        ...mono,
        position: "absolute",
        right: 1920 - frame.right,
        top: frame.bottom + 22,
        fontSize: 20,
        color: color.ink,
        display: "flex",
        alignItems: "center",
        gap: 12,
        textShadow: "0 0 0.8em rgb(236 232 220 / 0.35)",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background: tint,
          boxShadow: `0 0 10px ${tint}`,
        }}
      />
      <span>
        <span style={{ color: color.faint }}>{kind}:</span>
        {shown}
      </span>
    </div>
  );
}

const scales: Scale[] = ["record", "instrument", "archive"];

const pad = (n: number) => String(n).padStart(2, "0");

const timecode = (f: number) => {
  const s = Math.floor(f / fps);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}:${pad(f % fps)}`;
};

export function Hud() {
  const f = useCurrentFrame();
  const [cut, index] = current(f);
  const { label, note } = describe(cut);
  const intro = ramp(f, 20, 50);
  const outro = f >= at.aha ? 0 : 1;
  const active = scaleOf(cut.shot);
  const progress = ramp(f, at.pattern, at.aha, (x) => x ** 3);
  const count = Math.round(totalRecords * progress);
  return (
    <div style={{ position: "absolute", inset: 0, opacity: intro * outro }}>
      <span style={{ ...readout, left: frame.left, top: frame.top - 42 }}>
        <span style={{ color: color.rule, marginRight: 18 }}>
          {String(index + 1).padStart(3, "0")}
        </span>
        {label}
      </span>
      <span style={{ ...readout, left: frame.left, top: frame.bottom + 24 }}>{note}</span>
      <Stamp cut={cut} f={f} />

      <span style={{ ...readout, left: 64, bottom: 52, color: color.rule }}>{timecode(f)}</span>
      <span style={{ ...readout, right: 64, bottom: 52, display: "flex", gap: 28 }}>
        {scales.map((s) => (
          <span key={s} style={{ color: s === active ? color.ink : color.rule }}>
            {s}
          </span>
        ))}
      </span>
      {f >= at.pattern ? (
        <span style={{ ...readout, right: 64, top: 52 }}>
          {count.toLocaleString("en-US")} records
        </span>
      ) : null}
    </div>
  );
}

export function Backdrop() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: `radial-gradient(1440px 740px at 50% -190px, rgb(236 232 220 / 0.07), transparent 70%), radial-gradient(1400px 900px at 50% 50%, transparent 55%, rgb(0 0 0 / 0.38)), ${color.ground}`,
      }}
    />
  );
}

/** Film grain that changes every frame, behind nothing: it sits over the whole picture at low strength. */
export function Grain() {
  const f = useCurrentFrame();
  return (
    <svg
      width={1920}
      height={1080}
      style={{ position: "absolute", inset: 0, opacity: 0.32, mixBlendMode: "overlay" }}
    >
      <filter id="grain">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.82"
          numOctaves={3}
          seed={f % 997}
          stitchTiles="stitch"
        />
        <feColorMatrix values="0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 .5 1.6 0 0 0 -.3" />
      </filter>
      <rect width="100%" height="100%" filter="url(#grain)" />
    </svg>
  );
}
