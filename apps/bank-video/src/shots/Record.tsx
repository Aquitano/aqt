import type { CSSProperties, ReactNode } from "react";

import {
  centre,
  color,
  frame,
  frameHeight,
  frameWidth,
  glow,
  kindColor,
  mono,
  serif,
} from "../brand";
import { mix, ramp } from "../motion";
import { mulberry, type Entry, type Kind } from "../records";
import { keystrokes, scanSweep } from "../timeline";

export type Clock = { t: number; duration: number; now: number };

/** The area inside the bracket, with its content centred. */
export function Stage({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        position: "absolute",
        left: frame.left,
        top: frame.top,
        width: frameWidth,
        height: frameHeight,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "0 88px",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A slow push-in on the content. The bracket is drawn outside it, so it never moves. */
export function Push({
  clock,
  by = 0.035,
  children,
}: {
  clock: Clock;
  by?: number;
  children: ReactNode;
}) {
  const scale = 1 + by * ramp(clock.t, 0, Math.max(clock.duration, 1), (x) => x);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        transform: `scale(${scale})`,
        transformOrigin: `${centre.x}px ${centre.y}px`,
      }}
    >
      {children}
    </div>
  );
}

type Medium = { entry: Entry; clock: Clock };

/** Keeps a number on the same line as the word after it, as in "2 attachments". */
const tie = (text: string) => text.replace(/(d) (?=S)/g, "$1 ");

const balanced: CSSProperties = { textWrap: "balance" };

const label: CSSProperties = { ...mono, fontSize: 18, color: color.faint, letterSpacing: "0.02em" };

function Mail({ entry }: Medium) {
  const rows = [
    ["from", entry.from],
    ["to", entry.from === "me" ? "Property office" : "me"],
  ];
  return (
    <Stage>
      <div style={{ display: "grid", gridTemplateColumns: "92px 1fr", rowGap: 10 }}>
        {rows.map(([name, value]) => (
          <div key={name} style={{ display: "contents" }}>
            <span style={label}>{name}</span>
            <span style={{ ...mono, fontSize: 18, color: color.dim }}>{value}</span>
          </div>
        ))}
      </div>
      <div style={{ height: 1, background: color.ruleSoft, margin: "30px 0 34px" }} />
      <div
        style={{
          ...serif,
          ...balanced,
          fontSize: 66,
          lineHeight: 1.1,
          color: color.ink,
          ...glow(0.5),
        }}
      >
        {tie(entry.text)}
      </div>
    </Stage>
  );
}

function Chat({ entry }: Medium) {
  const tint = kindColor[entry.kind];
  return (
    <Stage style={{ alignItems: "flex-start" }}>
      <span style={{ ...mono, fontSize: 18, color: tint, marginBottom: 14, marginLeft: 6 }}>
        {entry.from}
      </span>
      <div
        style={{
          maxWidth: 760,
          padding: "24px 32px 18px",
          border: `1.5px solid color-mix(in srgb, ${tint} 70%, transparent)`,
          borderRadius: "6px 26px 26px 26px",
          background: `color-mix(in srgb, ${tint} 7%, transparent)`,
          boxShadow: `0 0 26px color-mix(in srgb, ${tint} 16%, transparent)`,
        }}
      >
        <div style={{ ...serif, ...balanced, fontSize: 60, lineHeight: 1.12, color: color.ink }}>
          {tie(entry.text)}
        </div>
        <div
          style={{ ...mono, fontSize: 15, color: color.faint, textAlign: "right", marginTop: 10 }}
        >
          {entry.time}
        </div>
      </div>
    </Stage>
  );
}

function Ai({ entry, clock }: Medium) {
  const tint = kindColor[entry.kind];
  const lines = [640, 700, 480];
  return (
    <Stage>
      <span style={{ ...mono, fontSize: 18, color: tint, marginBottom: 16 }}>you</span>
      <div style={{ ...serif, ...balanced, fontSize: 60, lineHeight: 1.12, color: color.ink }}>
        <span style={{ ...mono, color: color.faint, fontSize: 44, marginRight: 18 }}>›</span>
        {entry.text}
      </div>
      <span style={{ ...mono, fontSize: 16, color: color.faint, margin: "38px 0 14px" }}>
        {entry.source.toLowerCase()}
      </span>
      {lines.map((w, i) => (
        <div
          key={w}
          style={{
            width: w * ramp(clock.t, i * 3, i * 3 + 6),
            height: 9,
            marginBottom: 12,
            background: color.ruleSoft,
          }}
        />
      ))}
    </Stage>
  );
}

function Library({ entry, clock }: Medium) {
  const tint = kindColor[entry.kind];
  const played = mix(
    0.58,
    0.64,
    ramp(clock.t, 0, clock.duration, (x) => x),
  );
  return (
    <Stage>
      <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
        <svg width="34" height="38" viewBox="0 0 34 38">
          <path d="M2 2 L32 19 L2 36 Z" fill="none" stroke={tint} strokeWidth="2.5" />
        </svg>
        <span style={{ ...serif, ...balanced, fontSize: 62, color: color.ink }}>
          {tie(entry.text)}
        </span>
      </div>
      <div style={{ position: "relative", height: 4, marginTop: 46, background: color.ruleSoft }}>
        <div
          style={{ position: "absolute", inset: 0, width: `${played * 100}%`, background: tint }}
        />
        <div
          style={{
            position: "absolute",
            left: `${played * 100}%`,
            top: -7,
            width: 18,
            height: 18,
            marginLeft: -9,
            borderRadius: 9,
            background: color.ink,
            boxShadow: `0 0 14px ${tint}`,
          }}
        />
      </div>
      <div style={{ ...label, display: "flex", justifyContent: "space-between", marginTop: 18 }}>
        <span>{entry.source.toLowerCase()} · watched</span>
        <span>{entry.text.includes("min") ? "" : "14:00"}</span>
      </div>
    </Stage>
  );
}

function Drives({ entry }: Medium) {
  const tint = kindColor[entry.kind];
  const cut = entry.text.lastIndexOf("/") + 1;
  return (
    <Stage>
      <svg width="58" height="72" viewBox="0 0 58 72" style={{ marginBottom: 30 }}>
        <path
          d="M2 2 H40 L56 18 V70 H2 Z M40 2 V18 H56"
          fill="none"
          stroke={tint}
          strokeWidth="2.5"
        />
      </svg>
      <div style={{ ...mono, fontSize: 40, lineHeight: 1.3, whiteSpace: "nowrap" }}>
        <span style={{ color: color.faint }}>{entry.text.slice(0, cut)}</span>
        <span style={{ color: color.ink, ...glow(0.5) }}>{entry.text.slice(cut)}</span>
      </div>
      <span style={{ ...label, marginTop: 22 }}>on {entry.from}</span>
    </Stage>
  );
}

function Voice({ entry, clock }: Medium) {
  const tint = kindColor[entry.kind];
  const random = mulberry(91);
  const bars = Array.from({ length: 96 }, (_, i) => {
    const envelope = Math.sin((i / 96) * Math.PI) ** 0.6;
    return 10 + envelope * (24 + random() * 120);
  });
  const head = ramp(clock.t, 0, clock.duration, (x) => x) * 0.5 + 0.18;
  return (
    <Stage style={{ alignItems: "center" }}>
      <span
        style={{ ...mono, fontSize: 18, color: tint, alignSelf: "flex-start", marginBottom: 26 }}
      >
        {entry.from} · voice note · 0:42
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 3, height: 140 }}>
        {bars.map((h, i) => (
          <div
            // oxlint-disable-next-line react/no-array-index-key -- bars are a fixed sequence that never reorders
            key={i}
            style={{
              width: 5,
              height: h,
              borderRadius: 2,
              background: i / bars.length < head ? tint : color.rule,
            }}
          />
        ))}
      </div>
    </Stage>
  );
}

function Close({ entry, clock }: Medium) {
  const focus = ramp(clock.t, 4, 34);
  return (
    <Stage style={{ padding: "0 40px", alignItems: "center" }}>
      <div
        style={{
          ...serif,
          fontSize: 96,
          lineHeight: 1.06,
          textAlign: "center",
          color: color.ink,
          filter: `blur(${mix(7, 0, focus)}px)`,
          transform: `translateX(${mix(
            26,
            -18,
            ramp(clock.t, 0, clock.duration, (x) => x),
          )}px)`,
          opacity: mix(0.4, 1, focus),
          ...glow(0.6),
        }}
      >
        {entry.text}
      </div>
    </Stage>
  );
}

const media = {
  mail: Mail,
  chat: Chat,
  ai: Ai,
  library: Library,
  drives: Drives,
} satisfies Record<Kind, (props: Medium) => ReactNode>;

export function RecordShot({
  entry,
  clock,
  close,
}: {
  entry: Entry;
  clock: Clock;
  close?: boolean;
}) {
  if (close) return <Close entry={entry} clock={clock} />;
  if (entry.voice) return <Voice entry={entry} clock={clock} />;
  const Shown = media[entry.kind];
  return <Shown entry={entry} clock={clock} />;
}

export function Caret({ clock }: { clock: Clock }) {
  const on = clock.now % 16 < 8 && clock.t > 14;
  return (
    <div
      style={{
        position: "absolute",
        left: centre.x - 14,
        top: centre.y - 28,
        width: 28,
        height: 56,
        background: color.ink,
        opacity: on ? 0.92 : 0,
        boxShadow: "0 0 22px rgb(236 232 220 / 0.35)",
      }}
    />
  );
}

export function Query({ command, query, clock }: { command: string; query: string; clock: Clock }) {
  const typed = keystrokes.filter((k) => k <= clock.now).length;
  return (
    <Stage>
      <div style={{ ...mono, fontSize: 40, color: color.ink, whiteSpace: "pre", ...glow(0.5) }}>
        <span style={{ color: color.faint }}>$ </span>
        {command} "{query.slice(0, typed)}
        {typed === query.length ? '"' : ""}
        <span
          style={{
            display: "inline-block",
            width: "0.55em",
            height: "1.05em",
            marginLeft: 2,
            verticalAlign: "text-bottom",
            background: color.ink,
            opacity: typed > 0 || clock.now % 16 < 8 ? 1 : 0,
          }}
        />
      </div>
    </Stage>
  );
}

const paperWords = [
  [0, "DEPOSIT RECEIPT"],
  [2, "Tenant"],
  [3, "Property"],
  [5, "Rental deposit"],
  [6, "1,850.00 EUR"],
  [8, "Received 26.02.2024"],
] as const;

export function Scan({ clock }: { clock: Clock }) {
  const sweep = ramp(clock.t, scanSweep.from, scanSweep.to, (x) => x);
  const paper = { width: 680, height: 440 };
  const rowHeight = 38;
  return (
    <div
      style={{
        position: "absolute",
        left: centre.x - paper.width / 2,
        top: centre.y - paper.height / 2,
        width: paper.width,
        height: paper.height,
        transform: "rotate(-1.6deg)",
        background: `linear-gradient(160deg, ${color.paper}, #b9b3a2)`,
        boxShadow: "0 24px 60px rgb(0 0 0 / 0.45)",
        padding: "34px 44px",
        overflow: "hidden",
      }}
    >
      {paperWords.map(([row, word]) => {
        const y = 34 + row * rowHeight;
        const seen = sweep * paper.height > y + 10;
        const title = row === 0;
        return (
          <div
            key={word}
            style={{
              position: "absolute",
              top: y,
              left: word.endsWith("EUR") ? 330 : 44,
              ...(title ? serif : mono),
              fontSize: title ? 30 : 17,
              letterSpacing: title ? "0.12em" : 0,
              color: color.print,
              outline: seen ? `1.5px solid ${kindColor.drives}` : "none",
              outlineOffset: 5,
              background: seen ? "rgb(149 180 212 / 0.18)" : "transparent",
            }}
          >
            {word}
          </div>
        );
      })}
      {[4, 7].map((row) => (
        <div
          key={row}
          style={{
            position: "absolute",
            top: 34 + row * rowHeight + 8,
            left: 44,
            width: 420,
            height: 7,
            background: "rgb(59 58 53 / 0.35)",
          }}
        />
      ))}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: sweep * paper.height - 40,
          height: 80,
          opacity: sweep < 1 ? 1 : 0,
          background:
            "linear-gradient(transparent, rgb(214 236 255 / 0.55) 48%, rgb(255 255 255 / 0.9) 50%, rgb(214 236 255 / 0.55) 52%, transparent)",
          mixBlendMode: "screen",
        }}
      />
    </div>
  );
}
