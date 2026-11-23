import { Audio } from "@remotion/media";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";

import { centre } from "../../brand";
import { Grain } from "../../Frame";
import { inOut, ramp } from "../../motion";
import { record } from "../../records";
import { height, width } from "../../timeline";
import { Grade, PhotoShot } from "../Photo";
import { photos } from "../photos";
import { at, durationInFrames, motif } from "../plan";
import { Lockup, OnLine, UnderLine } from "../Type";
import { blend, cameraAt, captions, overscan, panels, streak, type Panel } from "./plan";

const tagline = "Search what you wrote, received and saved.";

/** An eased ramp of opacity across the blend, so a join reads as one soft seam. */
const seam = `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1]
  .map((t) => `rgb(0 0 0 / ${(t * t * (3 - 2 * t)).toFixed(3)}) ${t * blend}px`)
  .join(", ")})`;

/** Blurs only along x, so the speed smears the images while the line itself stays sharp. */
function Streak({ deviation }: { deviation: number }) {
  return (
    <svg width={0} height={0} style={{ position: "absolute" }}>
      <filter id="streak" x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
        <feGaussianBlur stdDeviation={`${deviation} 0`} />
      </filter>
    </svg>
  );
}

/** One image of the strip, cropped between its two joins and faded in over the one before. */
function PanelView({ panel }: { panel: Panel }) {
  const left = panel.from - blend / 2;
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left,
        width: panel.to - panel.from + blend,
        height,
        overflow: "hidden",
        maskImage: panel.first ? undefined : seam,
      }}
    >
      <Img
        src={staticFile(`images/${panel.photo.file}`)}
        style={{
          position: "absolute",
          left: panel.image.left - left,
          top: panel.image.top,
          width: panel.image.width,
          height: panel.image.height,
          filter: `brightness(${2 ** (panel.photo.stops ?? 0)}) url(#grade)`,
        }}
      />
    </div>
  );
}

/** Every image end to end on one horizon, moved as a whole under a fixed camera. */
function Strip({ now }: { now: number }) {
  const x = cameraAt(now);
  const deviation = streak(now);
  const left = x - centre.x - overscan;
  const right = x + centre.x + overscan;
  const visible = panels.filter((p) => p.to + blend / 2 > left && p.from - blend / 2 < right);
  return (
    <>
      <Streak deviation={deviation} />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: -overscan,
          width: width + 2 * overscan,
          height,
          overflow: "hidden",
          filter: deviation > 0 ? "url(#streak)" : undefined,
        }}
      >
        <div style={{ position: "absolute", inset: 0, transform: `translateX(${-left}px)` }}>
          {visible.map((panel) => (
            <PanelView key={panel.from} panel={panel} />
          ))}
        </div>
      </div>
    </>
  );
}

/** Fades the words towards the sides of the frame, letter by letter, so none is cut at an edge. */
const lens = "linear-gradient(to right, transparent 6%, #000 25%, #000 75%, transparent 94%)";

/** Words fixed to the strip: they slide through on the line and surface as they near the centre. */
function Captions({ now }: { now: number }) {
  const x = cameraAt(now);
  return (
    <AbsoluteFill style={{ maskImage: lens }}>
      {captions.map((caption) => {
        const offset = caption.x - x;
        return Math.abs(offset) < width ? (
          <AbsoluteFill key={caption.text} style={{ transform: `translateX(${offset}px)` }}>
            <OnLine text={caption.text} />
          </AbsoluteFill>
        ) : null;
      })}
    </AbsoluteFill>
  );
}

/** The hard stop: the calm horizon, the answer and its ref, then the mark on the third note. */
function Finale({ now }: { now: number }) {
  const answer = record("answer");
  const release = 1 - ramp(now, motif[1], motif[1] + 16);
  return (
    <>
      {now < motif[1] + 16 ? (
        <>
          <OnLine text={answer.text} size={58} opacity={release} />
          <UnderLine text={`${answer.source} · ${answer.ref}`} opacity={release} />
        </>
      ) : null}
      {now >= motif[2] ? (
        <Lockup
          opacity={ramp(now, motif[2], motif[2] + 18, inOut)}
          tagline={tagline}
          taglineOpacity={ramp(now, motif[2] + 40, motif[2] + 64)}
        />
      ) : null}
    </>
  );
}

/** The Frieze version: no cuts, one panorama of every image on a single horizon, until the answer. */
export function Frieze() {
  const now = useCurrentFrame();
  const light = ramp(now, 0, 18) * (1 - ramp(now, durationInFrames - 30, durationInFrames - 2));
  const moving = now < at.aha;
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Grade />
      <AbsoluteFill style={{ opacity: light }}>
        {moving ? (
          <Strip now={now} />
        ) : (
          <PhotoShot photo={photos.rays} push={(now - at.aha) / (durationInFrames - at.aha)} />
        )}
        <AbsoluteFill
          style={{
            background:
              "radial-gradient(1500px 950px at 50% 50%, transparent 52%, rgb(0 0 0 / 0.5)), linear-gradient(transparent 70%, rgb(0 0 0 / 0.25))",
          }}
        />
        {moving ? <Captions now={now} /> : <Finale now={now} />}
      </AbsoluteFill>
      <Grain />
      <Audio src={staticFile("score-frieze.wav")} />
    </AbsoluteFill>
  );
}
