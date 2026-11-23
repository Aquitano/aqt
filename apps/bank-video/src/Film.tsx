import { Audio } from "@remotion/media";
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame } from "remotion";

import { Axis, Backdrop, Bracket, Grain, Hud } from "./Frame";
import { easeIn, mix, ramp } from "./motion";
import { ShotView } from "./Shot";
import { FieldCanvas, cameras } from "./shots/Field";
import { at, bar, cuts, durationInFrames } from "./timeline";

/** The whole archive behind the cascade, pulling back from a month to eleven years. */
function CascadeField() {
  const f = useCurrentFrame();
  if (f < at.cascade || f >= at.aha) return null;
  const p = ramp(f, at.cascade, at.aha, (x) => x);
  const from = cameras.month;
  const to = cameras.decade;
  const peak = ramp(f, at.aha - 2 * bar, at.aha, easeIn);
  return (
    <div style={{ position: "absolute", inset: 0, opacity: mix(0.45, 0.9, peak) }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: peak,
          background:
            "radial-gradient(900px 420px at 50% 50%, rgb(236 232 220 / 0.16), transparent 70%)",
        }}
      />
      <FieldCanvas
        camera={{
          at: mix(from.at, to.at, p ** 0.6),
          pxPerDay: Math.exp(mix(Math.log(from.pxPerDay), Math.log(to.pxPerDay), p ** 0.8)),
          spread: mix(from.spread, to.spread, p),
          converge: 0.9 * ramp(f, at.aha - 2 * bar, at.aha, easeIn),
          gain: mix(0.4, 1, p),
        }}
      />
    </div>
  );
}

export function Film() {
  const f = useCurrentFrame();
  const light = ramp(f, 0, 24) * (1 - ramp(f, durationInFrames - 42, durationInFrames - 4));
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <AbsoluteFill style={{ opacity: light }}>
        <Backdrop />
        <CascadeField />
        {cuts.map((cut) => (
          <Sequence key={cut.from} from={cut.from} durationInFrames={cut.duration} layout="none">
            <ShotView cut={cut} />
          </Sequence>
        ))}
        <Axis />
        <Bracket />
        <Hud />
        <Grain />
      </AbsoluteFill>
      <Audio src={staticFile("score.wav")} />
    </AbsoluteFill>
  );
}
