import { Audio } from "@remotion/media";
import { AbsoluteFill, staticFile, useCurrentFrame } from "remotion";

import { mono, serif } from "../../brand";
import { Grain } from "../../Frame";
import { inOut, mix, ramp } from "../../motion";
import { record } from "../../records";
import { Grade } from "../Photo";
import { at, durationInFrames, motif } from "../plan";
import { Lockup } from "../Type";
import { OrbShot, apex, disc, graded } from "./Orb";
import { orbs, spans, sequence } from "./plan";

const paper = "#f4f0e6";

/** Serif words standing on the disc's top edge, the way a word stands on a horizon. */
function OnApex({
  text,
  size = 76,
  opacity = 1,
}: {
  text: string;
  size?: number;
  opacity?: number;
}) {
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, opacity }}>
      <text
        x={disc.x}
        y={apex - size * 0.3}
        textAnchor="middle"
        fill={paper}
        fontSize={size}
        style={{ ...serif, filter: "drop-shadow(0 2px 16px rgb(0 0 0 / 0.6))" }}
      >
        {text}
      </text>
    </svg>
  );
}

export function OrbFilm() {
  const now = useCurrentFrame();
  const cut = sequence.find((c) => now >= c.from && now < c.from + c.duration);
  const orb = orbs[cut?.orb ?? "moon"];
  const push = cut && now < at.aha ? (now - cut.from) / cut.duration : 0;
  const word = spans.find((s) => now >= s.from && now < s.to);
  const answer = record("answer");
  const release = 1 - ramp(now, motif[1], motif[1] + 16);
  const lockup = ramp(now, motif[2], motif[2] + 20, inOut);
  const tagline = ramp(now, motif[2] + 44, motif[2] + 68);
  const light = ramp(now, 0, 18) * (1 - ramp(now, durationInFrames - 30, durationInFrames - 2));
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Grade />
      <AbsoluteFill style={{ opacity: light, background: graded }}>
        <OrbShot orb={orb} push={push} />
        {word ? <OnApex text={word.text} /> : null}
        {now >= at.aha ? (
          <>
            <OnApex text={answer.text} size={50} opacity={release} />
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: disc.y + disc.diameter / 2 + 36,
                textAlign: "center",
                ...mono,
                fontSize: 20,
                color: "#e9e4d6",
                opacity: release * 0.85,
              }}
            >
              Gmail · {answer.ref}
            </div>
            <Lockup opacity={lockup} y={apex - 26} size={110} />
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: disc.y + disc.diameter / 2 + 30,
                textAlign: "center",
                ...serif,
                fontSize: 36,
                color: paper,
                opacity: tagline * 0.85,
                transform: `translateY(${mix(6, 0, tagline)}px)`,
              }}
            >
              Search what you wrote, received and saved.
            </div>
          </>
        ) : null}
      </AbsoluteFill>
      <Grain />
      <Audio src={staticFile("score-orbs.wav")} />
    </AbsoluteFill>
  );
}
