import type { ReactNode } from "react";

import { centre, color, glow, kindColor, lineGlow, mono } from "../brand";
import { inOut, mix, ramp } from "../motion";
import { hex, mulberry, totalRecords, type Entry } from "../records";
import { Stage, type Clock } from "./Record";

/** A diagram box with the siglum's two corners, as on the landing page. */
function Node({
  x,
  y,
  w,
  title,
  sub,
  tint = color.ink,
  strong,
}: {
  x: number;
  y: number;
  w: number;
  title: ReactNode;
  sub: string;
  tint?: string;
  strong?: boolean;
}) {
  const corner = {
    position: "absolute",
    width: 9,
    height: 9,
    borderColor: color.ink,
    borderStyle: "solid",
  } as const;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y - 34,
        width: w,
        height: 68,
        border: `1px solid ${strong ? color.dim : color.rule}`,
        background: "rgb(236 232 220 / 0.04)",
        boxShadow: strong ? "0 0 20px rgb(236 232 220 / 0.14)" : "none",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "0 18px",
      }}
    >
      <span style={{ ...corner, left: -1, top: -1, borderWidth: "1.5px 0 0 1.5px" }} />
      <span style={{ ...corner, right: -1, bottom: -1, borderWidth: "0 1.5px 1.5px 0" }} />
      <span style={{ ...mono, fontSize: 20, color: tint, whiteSpace: "nowrap", ...glow(0.4) }}>
        {title}
      </span>
      <span
        style={{ ...mono, fontSize: 14, color: color.faint, marginTop: 5, whiteSpace: "nowrap" }}
      >
        {sub}
      </span>
    </div>
  );
}

const sourceKey = (entry: Entry) =>
  entry.kind === "drives" ? "bytes" : entry.source.toLowerCase().replace(/[^a-z]/g, "");

/** How a ref comes from what identifies the record: a BLAKE3 digest, cut to 16 hex digits. */
export function Derive({ entry, clock }: { entry: Entry; clock: Clock }) {
  const [kind, value = ""] = entry.ref.split(":");
  const random = mulberry(value.length * 977 + value.charCodeAt(0) + value.charCodeAt(5));
  const digest = value.slice(0, 16) + hex(random, 24);
  const jitter = mulberry(clock.now * 131 + 7);
  const settle = (i: number) => clock.t >= (i / digest.length) * clock.duration * 0.4;
  const shown = digest
    .split("")
    .map((c, i) => (settle(i) ? c : hex(jitter, 1)))
    .join("");
  const cut = ramp(clock.t, clock.duration * 0.3, clock.duration * 0.5);
  const isFile = entry.kind === "drives";
  const identity = isFile
    ? (entry.text.split("/").pop() ?? entry.text)
    : `<${value.slice(3, 11).toUpperCase()}x${value.slice(11, 14)}@mail.${sourceKey(entry)}.com>`;
  const rows: { name: string; content: ReactNode }[] = [
    { name: "source", content: sourceKey(entry) },
    { name: isFile ? "file" : "message-id", content: identity },
    {
      name: "blake3",
      content: (
        <>
          <span style={{ color: color.ink, ...glow(cut) }}>{shown.slice(0, 16)}</span>
          <span style={{ color: color.faint, opacity: mix(1, 0.35, cut) }}>{shown.slice(16)}…</span>
        </>
      ),
    },
    {
      name: "ref",
      content: (
        <span style={{ color: color.ink, opacity: cut, ...glow(1) }}>
          {kind}:{value.slice(0, 16)}
        </span>
      ),
    },
  ];
  return (
    <Stage>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "200px 1fr",
          rowGap: 38,
          alignItems: "baseline",
        }}
      >
        {rows.map(({ name, content }) => (
          <div key={name} style={{ display: "contents" }}>
            <span style={{ ...mono, fontSize: 20, color: color.faint }}>{name}</span>
            <span style={{ ...mono, fontSize: 29, color: color.dim, whiteSpace: "nowrap" }}>
              {content}
            </span>
          </div>
        ))}
      </div>
    </Stage>
  );
}

const Line = ({
  d,
  progress,
  tint = color.dim,
}: {
  d: string;
  progress: number;
  tint?: string;
}) => (
  <path
    d={d}
    fill="none"
    stroke={tint}
    strokeWidth={1.5}
    pathLength={100}
    strokeDasharray="100"
    strokeDashoffset={100 - progress * 100}
  />
);

const Svg = ({ children }: { children: ReactNode }) => (
  <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, ...lineGlow }}>
    {children}
  </svg>
);

/** A ref names a mail, the mail has an attachment, and the same bytes sit on two drives. */
export function Resolve({ clock }: { clock: Clock }) {
  const step = (i: number) =>
    ramp(clock.t, i * clock.duration * 0.18, (i + 1) * clock.duration * 0.18 + 1);
  const x = centre.x;
  const rows = [345, 455, 565, 705];
  const [ref = 0, mail = 0, file = 0, drives = 0] = rows;
  const half = 34;
  const flow = (text: string, y: number) => (
    <span
      style={{
        ...mono,
        position: "absolute",
        left: x + 14,
        top: y - 9,
        fontSize: 14,
        color: color.faint,
      }}
    >
      {text}
    </span>
  );
  return (
    <>
      <Svg>
        <Line d={`M${x} ${ref + half} V${mail - half}`} progress={step(0)} />
        <Line d={`M${x} ${mail + half} V${file - half}`} progress={step(1)} />
        <Line
          d={`M${x} ${file + half} C${x} ${drives - 40} ${x - 130} ${file + 60} ${x - 130} ${drives - half}`}
          progress={step(2)}
          tint={kindColor.drives}
        />
        <Line
          d={`M${x} ${file + half} C${x} ${drives - 40} ${x + 130} ${file + 60} ${x + 130} ${drives - half}`}
          progress={step(2)}
          tint={kindColor.drives}
        />
      </Svg>
      <Node x={x - 170} y={ref} w={340} title="msg:a04d77e19c52f3b0" sub="cited in a note" strong />
      <Node
        x={x - 170}
        y={mail}
        w={340}
        title="Fwd: Signed lease"
        sub="mail to Property office"
        tint={kindColor.mail}
      />
      <Node x={x - 170} y={file} w={340} title="lease_signed.pdf" sub="attachment, 2.4 MB" />
      <Node
        x={x - 240}
        y={drives}
        w={220}
        title="archive-2"
        sub="/scans/2024/"
        tint={kindColor.drives}
      />
      <Node x={x + 20} y={drives} w={220} title="nas" sub="/backup/" tint={kindColor.drives} />
      {flow("names", (ref + mail) / 2)}
      {flow("attachment", (mail + file) / 2)}
      {flow("same bytes", file + 62)}
    </>
  );
}

const blocks = "repeating-linear-gradient(90deg, #ece8dc 0 5px, transparent 5px 7px)";

/** Importing the same export twice: everything is new the first time, nothing the second. */
export function Count({ clock }: { clock: Clock }) {
  const fill = ramp(clock.t, 0, clock.duration * 0.7, inOut);
  const runs = [
    { when: "first import", fresh: Math.round(totalRecords * fill), known: 0, width: fill },
    { when: "second import", fresh: 0, known: Math.round(totalRecords * fill), width: 0 },
  ];
  return (
    <Stage>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "220px 1fr 110px 110px",
          rowGap: 34,
          alignItems: "center",
        }}
      >
        <span />
        <span />
        <span style={{ ...mono, fontSize: 15, color: color.faint, textAlign: "right" }}>new</span>
        <span style={{ ...mono, fontSize: 15, color: color.faint, textAlign: "right" }}>known</span>
        {runs.map((run) => (
          <div key={run.when} style={{ display: "contents" }}>
            <span style={{ ...mono, fontSize: 20, color: color.dim }}>{run.when}</span>
            <span
              style={{
                height: 16,
                borderLeft: `1px solid ${color.ruleSoft}`,
                display: "flex",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  height: 16,
                  width: `${run.width * 100}%`,
                  background: blocks,
                  filter: "drop-shadow(0 0 5px rgb(236 232 220 / 0.45))",
                }}
              />
            </span>
            <span
              style={{
                ...mono,
                fontSize: 22,
                textAlign: "right",
                color: run.fresh ? color.ink : color.faint,
              }}
            >
              {run.fresh.toLocaleString("en-US")}
            </span>
            <span style={{ ...mono, fontSize: 22, textAlign: "right", color: color.faint }}>
              {run.known.toLocaleString("en-US")}
            </span>
          </div>
        ))}
      </div>
    </Stage>
  );
}

const identities = [
  { name: "whatsapp:Anna", tint: kindColor.chat },
  { name: "anna.k@example.com", tint: kindColor.mail },
  { name: "discord:anna_k", tint: kindColor.chat },
];

/** One person, many identities: every message she sent, from any source. */
export function Contact({ clock }: { clock: Clock }) {
  const draw = ramp(clock.t, 0, clock.duration * 0.6, inOut);
  const target = { x: centre.x, y: centre.y };
  const from = centre.x - 230;
  return (
    <>
      <Svg>
        {identities.map((id, i) => {
          const y = centre.y - 120 + i * 120;
          return (
            <Line
              key={id.name}
              d={`M${from} ${y} C${from + 110} ${y} ${target.x - 110} ${target.y} ${target.x} ${target.y}`}
              progress={draw}
              tint={id.tint}
            />
          );
        })}
        <circle cx={target.x} cy={target.y} r={6} fill={color.ink} opacity={draw} />
      </Svg>
      {identities.map((id, i) => (
        <span
          key={id.name}
          style={{
            ...mono,
            position: "absolute",
            right: 1920 - from + 18,
            top: centre.y - 120 + i * 120 - 15,
            fontSize: 24,
            color: id.tint,
          }}
        >
          {id.name}
        </span>
      ))}
      <div
        style={{
          position: "absolute",
          left: target.x + 24,
          top: target.y - 34,
          opacity: ramp(clock.t, clock.duration * 0.45, clock.duration * 0.7),
        }}
      >
        <div style={{ ...mono, fontSize: 46, color: color.ink, ...glow(1) }}>anna</div>
        <div style={{ ...mono, fontSize: 15, color: color.faint, marginTop: 6 }}>one contact</div>
      </div>
    </>
  );
}
