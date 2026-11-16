import { useLayoutEffect, useRef } from "react";

import { archive, dayOf, firstYear, years } from "../archive";
import { centre, color, frame, glow, kindColor, lineGlow, mono } from "../brand";
import { inOut, ramp } from "../motion";
import { day, type Kind } from "../records";
import { height, width } from "../timeline";
import type { Clock } from "./Record";

const minutesOf = (time: string) => {
  const [h = 0, m = 0] = time.split(":").map(Number);
  return h * 60 + m;
};

/** 2024-02-26 as a line: every record of the day, from every source, on one axis. */
export function Day({ clock }: { clock: Clock }) {
  const left = frame.left + 70;
  const right = frame.right - 70;
  const open = 7 * 60;
  const x = (minutes: number) => left + ((minutes - open) / (1440 - open)) * (right - left);
  const head = open + ramp(clock.t, 0, clock.duration, (v) => v) * (1440 - open);
  const draw = ramp(clock.t, 0, Math.min(10, clock.duration * 0.5), inOut);
  return (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0, ...lineGlow }}>
      <line
        x1={left}
        x2={left + (right - left) * draw}
        y1={centre.y}
        y2={centre.y}
        stroke={color.dim}
        strokeWidth={1.5}
      />
      {[8, 12, 16, 20, 24].map((h) => (
        <g key={h}>
          <line
            x1={x(h * 60)}
            x2={x(h * 60)}
            y1={centre.y - 6}
            y2={centre.y + 6}
            stroke={color.rule}
            strokeWidth={1.5}
          />
          <text
            x={x(h * 60)}
            y={frame.bottom - 28}
            fill={color.faint}
            fontSize={15}
            textAnchor="middle"
            style={mono}
          >
            {String(h).padStart(2, "0")}:00
          </text>
        </g>
      ))}
      {day.map((entry, i) => {
        const m = minutesOf(entry.time);
        const lit = head >= m;
        const up = i % 2 === 0;
        const length = 50 + Math.floor(i / 2) * 46;
        const tip = centre.y + (up ? -length : length);
        const tint = kindColor[entry.kind];
        const late = x(m) > centre.x + 120;
        const shortText = entry.text.length > 26 ? `${entry.text.slice(0, 25)}…` : entry.text;
        return (
          <g key={entry.ref} opacity={lit ? 1 : 0.25}>
            <line x1={x(m)} x2={x(m)} y1={centre.y} y2={tip} stroke={tint} strokeWidth={1.5} />
            <circle cx={x(m)} cy={centre.y} r={lit ? 5.5 : 3.5} fill={tint} />
            <text
              x={x(m) + (late ? -10 : 10)}
              y={tip + (up ? 5 : 5)}
              fill={lit ? color.ink : color.faint}
              fontSize={16}
              textAnchor={late ? "end" : "start"}
              style={mono}
            >
              {shortText}
            </text>
          </g>
        );
      })}
      <line
        x1={x(head)}
        x2={x(head)}
        y1={centre.y - 230}
        y2={centre.y + 230}
        stroke={color.ink}
        strokeWidth={1}
        opacity={0.5}
      />
    </svg>
  );
}

const sources: { name: string; kind: Kind }[] = [
  { name: "Gmail", kind: "mail" },
  { name: "IMAP", kind: "mail" },
  { name: "mbox, EML", kind: "mail" },
  { name: "WhatsApp", kind: "chat" },
  { name: "Discord", kind: "chat" },
  { name: "LinkedIn", kind: "chat" },
  { name: "ChatGPT", kind: "ai" },
  { name: "Claude", kind: "ai" },
  { name: "YouTube", kind: "library" },
  { name: "Netflix", kind: "library" },
  { name: "Documents", kind: "library" },
  { name: "Drives", kind: "drives" },
];

/** Twelve sources, one archive. */
export function Sources({ clock }: { clock: Clock }) {
  const draw = ramp(clock.t, 0, Math.max(clock.duration * 0.7, 3), inOut);
  const top = frame.top + 40;
  const gap = (frame.bottom - frame.top - 80) / (sources.length - 1);
  const from = centre.x - 270;
  const to = { x: centre.x - 75, y: centre.y };
  return (
    <>
      <svg width={width} height={height} style={{ position: "absolute", inset: 0, ...lineGlow }}>
        {sources.map((s, i) => {
          const y = top + i * gap;
          return (
            <path
              key={s.name}
              d={`M${from} ${y} C${from + 200} ${y} ${to.x - 170} ${to.y} ${to.x} ${to.y}`}
              fill="none"
              stroke={kindColor[s.kind]}
              strokeWidth={1.3}
              opacity={0.85}
              pathLength={100}
              strokeDasharray="100"
              strokeDashoffset={100 - draw * 100}
            />
          );
        })}
      </svg>
      {sources.map((s, i) => (
        <span
          key={s.name}
          style={{
            ...mono,
            position: "absolute",
            right: width - from + 16,
            top: top + i * gap - 11,
            fontSize: 19,
            color: kindColor[s.kind],
          }}
        >
          {s.name}
        </span>
      ))}
      <div
        style={{
          position: "absolute",
          left: to.x,
          top: to.y - 26,
          width: 150,
          height: 60,
          border: `1px solid ${color.dim}`,
          boxShadow: "0 0 24px rgb(236 232 220 / 0.18)",
          display: "grid",
          placeItems: "center",
          ...mono,
          fontSize: 26,
          color: color.ink,
          opacity: ramp(clock.t, 0, 3),
          ...glow(0.8),
        }}
      >
        siglum
      </div>
    </>
  );
}

const plate = {
  left: frame.left + 96,
  right: frame.right - 40,
  top: frame.top + 30,
  bottom: frame.bottom - 24,
};
const rowHeight = (plate.bottom - plate.top) / years;

/** Every day of eleven years as a seismograph strip per year: the taller, the more was written. */
const drawPlate = (canvas: HTMLCanvasElement, exposure: number) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  const step = (plate.right - plate.left) / 366;
  const marked = Math.floor(dayOf("2024-02-26"));
  for (let row = 0; row < years; row++) {
    const base = plate.top + (row + 1) * rowHeight - 6;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color.ruleSoft;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plate.left, base + 0.5);
    ctx.lineTo(plate.right, base + 0.5);
    ctx.stroke();
  }
  for (let i = 0; i < archive.perDay.length; i++) {
    const date = new Date(Date.UTC(firstYear, 0, 1 + i));
    const row = date.getUTCFullYear() - firstYear;
    const column = Math.floor(
      (date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86_400_000,
    );
    const reveal = Math.min(Math.max(exposure * 1.6 * 366 - column, 0) / 30, 1);
    if (reveal <= 0) continue;
    const level = ((archive.perDay[i] ?? 0) / archive.maxPerDay) ** 0.55;
    const base = plate.top + (row + 1) * rowHeight - 6;
    const x = plate.left + column * step;
    const isMarked = i === marked;
    ctx.strokeStyle = isMarked ? kindColor.mail : color.ink;
    ctx.globalAlpha = isMarked ? 1 : 0.35 + level * 0.65;
    ctx.lineWidth = isMarked ? 2.5 : 1.2;
    ctx.beginPath();
    ctx.moveTo(x, base);
    ctx.lineTo(x, base - Math.max(level * (rowHeight - 12), 1) * reveal - (isMarked ? 6 : 0));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
};

export function Plate({ clock }: { clock: Clock }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const exposure = ramp(clock.t, 0, Math.max(clock.duration * 0.8, 3), (v) => v);
  useLayoutEffect(() => {
    if (ref.current) drawPlate(ref.current, exposure);
  }, [exposure]);
  return (
    <>
      <canvas
        ref={ref}
        width={width}
        height={height}
        style={{ position: "absolute", inset: 0, ...lineGlow }}
      />
      {Array.from({ length: years }, (_, row) => (
        <span
          key={row}
          style={{
            ...mono,
            position: "absolute",
            left: frame.left + 24,
            top: plate.top + (row + 1) * rowHeight - 22,
            fontSize: 14,
            color: color.faint,
          }}
        >
          {firstYear + row}
        </span>
      ))}
    </>
  );
}
