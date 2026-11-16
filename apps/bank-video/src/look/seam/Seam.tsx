import { Audio } from "@remotion/media";
import { AbsoluteFill, staticFile, useCurrentFrame } from "remotion";

import { centre } from "../../brand";
import { Grain } from "../../Frame";
import { inOut, ramp } from "../../motion";
import { record } from "../../records";
import { bar, beat, height, width } from "../../timeline";
import { Grade, PhotoShot } from "../Photo";
import { photos } from "../photos";
import { at, durationInFrames, motif } from "../plan";
import { Lockup, OnLine, UnderLine } from "../Type";
import { halves, type Shot } from "./plan";

const phrases = [
  { from: at.pattern, to: at.harmony, text: "What you wrote" },
  { from: at.harmony, to: at.harmony + 2 * bar, text: "meets what you received." },
  { from: at.cascade, to: at.cascade + 2 * bar, text: "Every source," },
  { from: at.cascade + 2 * bar, to: at.aha, text: "one line." },
];

const answer = record("answer");
/** Half a beat of the whole photograph alone, then the answer. */
const answerAt = at.aha + beat / 2;
const tagline = "Search what you wrote, received and saved.";

/** Clips a full frame rather than moving it, so the photograph's line stays on the screen's. */
function Half({ shots, clip, now }: { shots: Shot[]; clip: string; now: number }) {
  const shot = shots.find((s) => now >= s.from && now < s.from + s.duration);
  if (!shot) return null;
  return (
    <AbsoluteFill style={{ clipPath: clip }}>
      <PhotoShot photo={photos[shot.photo]} push={(now - shot.from) / shot.duration} />
    </AbsoluteFill>
  );
}

function Seamline() {
  return (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
      <defs>
        <linearGradient id="seamline" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#f6f2e8" stopOpacity={0} />
          <stop offset="50%" stopColor="#f6f2e8" stopOpacity={0.3} />
          <stop offset="100%" stopColor="#f6f2e8" stopOpacity={0} />
        </linearGradient>
      </defs>
      <rect
        x={0}
        y={centre.y - 1}
        width={width}
        height={2}
        fill="url(#seamline)"
        style={{ filter: "drop-shadow(0 0 4px rgb(246 242 232 / 0.35))" }}
      />
    </svg>
  );
}

/** Two records meet on one line, until the cut joins them into one photograph. */
export function Seam() {
  const now = useCurrentFrame();
  const light = ramp(now, 0, 18) * (1 - ramp(now, durationInFrames - 30, durationInFrames - 2));
  const phrase = phrases.find((p) => now >= p.from && now < p.to);
  const arrive = ramp(now, answerAt, answerAt + 10);
  const release = 1 - ramp(now, motif[1], motif[1] + 16);
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Grade />
      <AbsoluteFill style={{ opacity: light }}>
        <Half shots={halves.top} clip={`inset(0 0 ${height - centre.y}px 0)`} now={now} />
        <Half shots={halves.bottom} clip={`inset(${centre.y}px 0 0 0)`} now={now} />
        <AbsoluteFill
          style={{
            background:
              "radial-gradient(1500px 950px at 50% 50%, transparent 52%, rgb(0 0 0 / 0.5)), linear-gradient(transparent 70%, rgb(0 0 0 / 0.25))",
          }}
        />
        {now < at.aha ? <Seamline /> : null}
        {phrase ? <OnLine text={phrase.text} /> : null}
        {now >= answerAt && now < motif[2] ? (
          <>
            <OnLine text={answer.text} size={58} opacity={arrive * release} />
            <UnderLine text={`${answer.source} · ${answer.ref}`} opacity={arrive * release} />
          </>
        ) : null}
        {now >= motif[2] ? (
          <Lockup
            opacity={ramp(now, motif[2], motif[2] + 18, inOut)}
            tagline={tagline}
            taglineOpacity={ramp(now, motif[2] + 40, motif[2] + 64)}
          />
        ) : null}
      </AbsoluteFill>
      <Grain />
      <Audio src={staticFile("score-seam.wav")} />
    </AbsoluteFill>
  );
}
