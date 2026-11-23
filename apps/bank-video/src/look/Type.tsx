import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { spring } from "remotion";

import { centre, color, display, mono, serif } from "../brand";
import { mix, ramp } from "../motion";
import { fps } from "../timeline";
import { Lettered, type Lettering } from "./Lettered";

const paper = "#f6f2e8";
const lift = "drop-shadow(0 2px 22px rgb(0 0 0 / 0.55))";

/** A full-frame layer whose children are SVG, drawn in screen pixels. */
function Layer({ children, opacity = 1 }: { children: ReactNode; opacity?: number }) {
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, opacity }}>
      {children}
    </svg>
  );
}

/** A wide, soft band of shade along the line, so type reads over any photograph. */
function Shade({ height }: { height: number }) {
  return (
    <>
      <defs>
        <radialGradient id="shade" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#000" stopOpacity={0.32} />
          <stop offset="55%" stopColor="#000" stopOpacity={0.16} />
          <stop offset="100%" stopColor="#000" stopOpacity={0} />
        </radialGradient>
      </defs>
      <ellipse
        cx={centre.x}
        cy={centre.y - height * 0.3}
        rx={780}
        ry={height * 1.5}
        fill="url(#shade)"
      />
    </>
  );
}

/** The size words stand on the line at. */
export const wordSize = 104;

/** Serif words standing on the line: the photograph's line is their baseline. */
export function OnLine({
  text,
  size = wordSize,
  opacity = 1,
  mark,
  lettering,
}: {
  text: string;
  size?: number;
  opacity?: number;
  /** A footnote number set as a superscript after the words. */
  mark?: number;
  /** Set the words into this shot, with no shade behind them. */
  lettering?: Lettering;
}) {
  if (lettering) {
    return <Lettered text={text} size={size} opacity={opacity} lettering={lettering} />;
  }
  return (
    <Layer opacity={opacity}>
      <Shade height={size} />
      <text
        x={centre.x}
        y={centre.y - 4}
        textAnchor="middle"
        fill={paper}
        fontSize={size}
        style={{ ...serif, filter: lift }}
      >
        {text}
        {mark === undefined ? null : (
          <tspan fontSize={size * 0.4} dy={-size * 0.46} dx={size * 0.06}>
            {mark}
          </tspan>
        )}
      </text>
    </Layer>
  );
}

/** A footnote at the foot of the frame, as an edition sets it: a short rule, the number, the source. */
export function Footnote({
  number,
  text,
  opacity = 1,
}: {
  number: string;
  text: string;
  opacity?: number;
}) {
  const left = 120;
  const baseline = 1080 - 78;
  return (
    <Layer opacity={opacity}>
      <defs>
        <linearGradient id="foot" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#000" stopOpacity={0} />
          <stop offset="100%" stopColor="#000" stopOpacity={0.55} />
        </linearGradient>
      </defs>
      <rect x={0} y={1080 - 200} width={1920} height={200} fill="url(#foot)" />
      <line
        x1={left}
        x2={left + 120}
        y1={baseline - 44}
        y2={baseline - 44}
        stroke={paper}
        strokeOpacity={0.55}
        strokeWidth={1}
      />
      <text x={left} y={baseline} fill={paper} fontSize={25} style={{ ...serif, filter: lift }}>
        <tspan fontSize={19} dy={-9}>
          {number}
        </tspan>
        <tspan dx={12} dy={9} fillOpacity={0.88}>
          {text}
        </tspan>
      </text>
    </Layer>
  );
}

const noteStyle: CSSProperties = { ...mono, filter: lift };

/** One small mono line hanging under the line: a source and its ref. */
export function UnderLine({ text, opacity = 1 }: { text: string; opacity?: number }) {
  return (
    <Layer opacity={opacity}>
      <text
        x={centre.x}
        y={centre.y + 44}
        textAnchor="middle"
        fill={paper}
        fontSize={22}
        fillOpacity={0.88}
        style={noteStyle}
      >
        {text}
      </text>
    </Layer>
  );
}

/**
 * Measures an SVG text's rendered width after every render, before paint; the fonts are loaded
 * first. Setting the same width again does not re-render.
 */
const useWidth = () => {
  const ref = useRef<SVGTextElement>(null);
  const [width, setWidth] = useState(0);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the text changes as it is typed, and an equal width stops the update chain
  useLayoutEffect(() => {
    setWidth(ref.current?.getComputedTextLength() ?? 0);
  });
  return [ref, width] as const;
};

/** A command typed onto the line, left-aligned so the finished line is centred. */
export function Typed({
  prefix,
  typed,
  full,
  caret,
}: {
  prefix: string;
  typed: string;
  full: string;
  caret: boolean;
}) {
  const shown = `${prefix}${typed}${typed.length === full.length ? '"' : ""}`;
  const [fullRef, fullWidth] = useWidth();
  const [shownRef, shownWidth] = useWidth();
  const size = 46;
  const left = centre.x - fullWidth / 2;
  return (
    <Layer>
      <Shade height={size * 1.6} />
      <text ref={fullRef} x={0} y={-100} fontSize={size} style={mono} visibility="hidden">
        {`${prefix}${full}"`}
      </text>
      <text ref={shownRef} x={left} y={centre.y - 4} fill={paper} fontSize={size} style={noteStyle}>
        <tspan fillOpacity={0.55}>{prefix.slice(0, 2)}</tspan>
        {shown.slice(2)}
      </text>
      {caret ? (
        <rect
          x={left + shownWidth + 6}
          y={centre.y - 4 - size * 0.8}
          width={size * 0.52}
          height={size * 0.95}
          fill={paper}
        />
      ) : null}
    </Layer>
  );
}

/** The mark is 23 units wide and the name follows it after a gap; together they are centred. */
const lockupLayout = (size: number, nameWidth: number) => {
  const unit = (size * 0.74) / 23;
  const gap = size * 0.28;
  const markWidth = 23 * unit;
  return { unit, gap, markWidth, left: centre.x - (markWidth + gap + nameWidth) / 2 };
};

/**
 * The favicon's mark and the wordmark, both standing on the line. The mark's bottom stroke
 * ends at 27.5 of its 32 units, and its visible left edge is at 4.5.
 */
export function Lockup({
  opacity,
  tagline,
  taglineOpacity = 0,
  y = centre.y,
  size = 136,
}: {
  opacity: number;
  tagline?: string;
  taglineOpacity?: number;
  /** The baseline both the mark and the name stand on. */
  y?: number;
  size?: number;
}) {
  const [ref, width] = useWidth();
  const { unit, gap, markWidth, left } = lockupLayout(size, width);
  return (
    <Layer>
      <g opacity={opacity} style={{ filter: lift }}>
        <g transform={`translate(${left - 4.5 * unit} ${y - 27.5 * unit}) scale(${unit})`}>
          <path d="M6 14V6h8M26 18v8h-8" stroke={color.ink} strokeWidth={3} fill="none" />
          <rect x={13} y={13} width={6} height={6} fill={color.ink} />
        </g>
        <text
          ref={ref}
          x={left + markWidth + gap}
          y={y}
          fill={paper}
          fontSize={size}
          style={display}
        >
          siglum
        </text>
      </g>
      {tagline ? (
        <text
          x={centre.x}
          y={y + 96}
          textAnchor="middle"
          fill={paper}
          fillOpacity={0.82}
          fontSize={40}
          opacity={taglineOpacity}
          style={{ ...serif, filter: lift }}
        >
          {tagline}
        </text>
      ) : null}
    </Layer>
  );
}

const letters = ["s", "i", "g", "l", "u", "m"] as const;
const settle = { damping: 10, stiffness: 300, mass: 0.5 } as const;
/** Each letter of the name settles into place: unhurried, and it stops without a bounce. */
const surface = { damping: 20, stiffness: 120, mass: 0.7 } as const;

/**
 * The mark arrives as a seal is pressed, one event per note, `step` frames apart: the square
 * stamps down and a glint runs out along the horizon, the frame snaps round it, and the name
 * appears letter by letter, each fading in as it settles a few pixels up onto the line. `since` counts frames from the first note.
 */
export function Arrival({
  since,
  step,
  y = centre.y,
  size = 136,
}: {
  since: number;
  step: number;
  y?: number;
  size?: number;
}) {
  const [ref, width] = useWidth();
  const { unit, gap, markWidth, left } = lockupLayout(size, width);
  const press = spring({ frame: since, fps, config: settle });
  const snap = spring({ frame: since - step, fps, config: settle });
  const answer = spring({ frame: since - step - 2, fps, config: settle });
  const square = { x: left + 11.5 * unit, y: y - 11.5 * unit };
  const glint = ramp(since, 2, 26);
  const fadeGlint = 1 - ramp(since, 8, 56);
  const reach = 9 * (1 - snap);
  return (
    <Layer>
      <defs>
        <linearGradient id="glint" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#ffe6b8" stopOpacity={0} />
          <stop offset="50%" stopColor="#fff4dc" stopOpacity={1} />
          <stop offset="100%" stopColor="#ffe6b8" stopOpacity={0} />
        </linearGradient>
      </defs>
      <rect
        x={square.x - 900 * glint}
        y={y - 1.5}
        width={1800 * glint}
        height={3}
        fill="url(#glint)"
        opacity={0.8 * fadeGlint * (since >= 2 ? 1 : 0)}
        style={{ filter: "blur(1.2px) drop-shadow(0 0 10px rgb(255 214 150 / 0.9))" }}
      />
      <g style={{ filter: lift }}>
        <g transform={`translate(${left - 4.5 * unit} ${y - 27.5 * unit}) scale(${unit})`}>
          <rect
            x={13}
            y={13}
            width={6}
            height={6}
            fill={color.ink}
            opacity={ramp(since, 0, 3)}
            transform={`translate(16 16) scale(${mix(1.3, 1, press)}) translate(-16 -16)`}
          />
          <g opacity={ramp(since, step, step + 4)}>
            <path
              d="M6 14V6h8"
              transform={`translate(${-reach} ${-reach})`}
              stroke={color.ink}
              strokeWidth={3}
              fill="none"
            />
            <path
              d="M26 18v8h-8"
              transform={`translate(${9 * (1 - answer)} ${9 * (1 - answer)})`}
              stroke={color.ink}
              strokeWidth={3}
              fill="none"
            />
          </g>
        </g>
        <text
          ref={ref}
          x={left + markWidth + gap}
          y={y}
          fill={paper}
          fontSize={size}
          style={display}
        >
          {letters.map((letter, i) => {
            const from = 2 * step + 3 * i;
            const rise = spring({ frame: since - from, fps, config: surface });
            return (
              <tspan
                key={letter + String(i)}
                y={y + size * 0.14 * (1 - rise)}
                fillOpacity={ramp(since, from, from + 8)}
              >
                {letter}
              </tspan>
            );
          })}
        </text>
      </g>
    </Layer>
  );
}
