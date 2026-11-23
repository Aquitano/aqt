import { dayOf } from "../archive";
import { centre, color, display, glow, kindColor, mono, serif } from "../brand";
import { logo } from "../Frame";
import { mix, ramp } from "../motion";
import { record, totalRecords } from "../records";
import { at, motif, query } from "../timeline";
import { FieldCanvas } from "./Field";
import type { Clock } from "./Record";

const word = "siglum";
const answer = record("answer");
const answerDay = dayOf(answer.date, answer.time);
const line = { position: "absolute", left: 0, right: 0, textAlign: "center" } as const;

/**
 * The widest, stillest shot: the whole archive, every stream narrowing into one point at the
 * centre of the bracket, and the answer beneath it. On the motif's second note the archive and
 * the words let go; on the third the point becomes the logo's square.
 */
export function Finale({ clock }: { clock: Clock }) {
  const f = clock.now;
  const release = ramp(f, motif[1], motif[1] + 14);
  const archive = 1 - ramp(f, motif[1], motif[1] + 26);
  const name = (i: number) => ramp(f, motif[2] + 22 + i * 3, motif[2] + 38 + i * 3);
  const tagline = ramp(f, motif[2] + 58, motif[2] + 82);
  const definition = ramp(f, motif[2] + 96, motif[2] + 120);
  return (
    <>
      <div style={{ position: "absolute", inset: 0, opacity: 0.6 * archive }}>
        <FieldCanvas
          camera={{
            at: answerDay,
            pxPerDay: ((centre.x - 90) / answerDay) * mix(1, 1.012, ramp(f, at.aha, motif[1])),
            spread: 420,
            converge: 0,
            gain: 0.7,
            funnel: answerDay,
          }}
        />
      </div>

      <div style={{ position: "absolute", inset: 0, opacity: 1 - release }}>
        <div style={{ ...line, top: centre.y - 92, ...mono, fontSize: 17, color: color.faint }}>
          search "{query.query}" · 1 of {totalRecords.toLocaleString("en-US")}
        </div>
        <div
          style={{
            ...line,
            top: centre.y + 46,
            ...serif,
            fontSize: 58,
            lineHeight: 1.1,
            color: color.ink,
            ...glow(0.7),
          }}
        >
          {answer.text}
        </div>
        <div style={{ ...line, top: centre.y + 132, ...mono, fontSize: 19, color: color.dim }}>
          <span style={{ color: kindColor.mail }}>{answer.from}</span> · mail · 29 Aug 2025,{" "}
          {answer.time}
        </div>
        <div style={{ ...line, top: centre.y + 172, ...mono, fontSize: 21, color: color.ink }}>
          <span
            style={{
              textDecoration: "underline",
              textDecorationColor: color.faint,
              textUnderlineOffset: 6,
              textShadow: "0 0 0.8em rgb(236 232 220 / 0.35)",
            }}
          >
            <span style={{ color: color.faint }}>msg:</span>
            {answer.ref.slice(4)}
          </span>
        </div>
      </div>

      <div
        style={{
          ...line,
          top: logo.rest + 120,
          display: "flex",
          justifyContent: "center",
          gap: "0.02em",
          ...display,
          fontSize: 116,
          lineHeight: 1,
          color: color.ink,
          textShadow: "0 0 28px rgb(236 232 220 / 0.22)",
        }}
      >
        {word.split("").map((letter, i) => (
          <span
            key={letter}
            style={{ opacity: name(i), transform: `translateY(${mix(10, 0, name(i))}px)` }}
          >
            {letter}
          </span>
        ))}
      </div>
      <div
        style={{
          ...line,
          top: logo.rest + 270,
          ...serif,
          fontSize: 42,
          color: color.dim,
          opacity: tagline,
        }}
      >
        Search what you wrote, received and saved.
      </div>
      <div
        style={{
          ...line,
          bottom: 64,
          ...mono,
          fontSize: 24,
          color: color.dim,
          opacity: definition,
        }}
      >
        siglum, n. the mark an editor uses to cite one source
      </div>
    </>
  );
}
