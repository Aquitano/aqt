import { Audio } from "@remotion/media";
import { AbsoluteFill, staticFile, useCurrentFrame } from "remotion";

import { Grain } from "../Frame";
import { inOut, ramp } from "../motion";
import { record } from "../records";
import { citations } from "./citations";
import type { Lettering } from "./Lettered";
import { letteringOf, sharedEdge } from "./lettering";
import { Grade, PhotoShot } from "./Photo";
import type { PhotoId } from "./photos";
import type { Arc } from "./plan";
import { Arrival, Footnote, Lockup, OnLine, Typed, UnderLine, wordSize } from "./Type";
import { photoOf, sourceOrder, type Span, type Version } from "./versions";

function Words({
  span,
  now,
  keystrokes,
  mark,
  lettering,
  scale,
  arc,
}: {
  span: Span;
  now: number;
  keystrokes: number[];
  mark?: number;
  lettering?: Lettering;
  scale: number;
  arc: Arc;
}) {
  const words = span.words;
  const since = now - span.from;
  switch (words.kind) {
    case "serif":
      return <OnLine text={words.text} size={wordSize * scale} mark={mark} lettering={lettering} />;
    case "hit":
      return (
        <>
          <OnLine text={words.text} size={84} lettering={lettering} />
          <UnderLine text={words.note} opacity={since >= 8 ? 1 : 0} />
        </>
      );
    case "ref":
      return <UnderLine text={words.note} />;
    case "query": {
      const typed = keystrokes.filter((k) => k <= now).length;
      return (
        <Typed
          prefix={`$ ${words.command} "`}
          typed={words.query.slice(0, typed)}
          full={words.query}
          caret={typed > 0 || now % 16 < 8}
        />
      );
    }
    case "answer": {
      const answer = record("answer");
      const release = 1 - ramp(now, arc.motif[1], arc.motif[1] + 16);
      return (
        <>
          <OnLine
            text={answer.text}
            size={58}
            opacity={release}
            mark={mark}
            lettering={lettering}
          />
          {words.note ? <UnderLine text={`Gmail · ${answer.ref}`} opacity={release} /> : null}
        </>
      );
    }
    case "lockup":
      return (
        <Lockup
          opacity={ramp(now, span.from, span.from + 18, inOut)}
          tagline={words.tagline}
          taglineOpacity={ramp(now, span.from + 40, span.from + 64)}
        />
      );
    case "seal":
      return <Arrival since={since} step={arc.motif[1] - arc.motif[0]} />;
    default:
      return words satisfies never;
  }
}

const answerNumber = sourceOrder.length + 1;

/**
 * The note for this frame: the image's source while the archive plays, the answer's own source
 * after the cut, and a closing note for every image once the mark has formed.
 */
const footnote = (photo: PhotoId, now: number, arc: Arc) => {
  if (now < arc.at.aha) {
    const number = sourceOrder.indexOf(photo) + 1;
    return {
      number: String(number),
      text: citations[photo],
      mark: number,
      opacity: ramp(now, 20, 34),
    };
  }
  if (now < arc.motif[2]) {
    const answer = record("answer");
    return {
      number: String(answerNumber),
      text: `${answer.from}, "${answer.text}" Mail, 29 Aug 2025. ${answer.ref}`,
      mark: answerNumber,
      opacity: 1 - ramp(now, arc.motif[1], arc.motif[1] + 16),
    };
  }
  return {
    number: `1–${sourceOrder.length}`,
    text: "Every image in this film is public domain or CC0, and cited where it appears.",
    mark: undefined,
    opacity: ramp(now, arc.motif[2] + 40, arc.motif[2] + 64),
  };
};

/** One photographic version: the shared cuts and images, with this version's words on the line. */
export function PhotoFilm({ version }: { version: Version }) {
  const now = useCurrentFrame();
  const { arc } = version;
  const cut =
    version.cuts.find((c) => now >= c.from && now < c.from + c.duration) ?? version.cuts[0];
  const spans = version.spans.filter((s) => now >= s.from && now < s.to);
  const light =
    ramp(now, 0, 18) * (1 - ramp(now, arc.durationInFrames - 48, arc.durationInFrames - 2, inOut));
  const note = version.footnotes && cut ? footnote(cut.photo, now, arc) : undefined;
  const shot = version.lettered && cut ? letteringOf(cut.photo) : undefined;
  const phrase = spans.find((s) => s.words.kind === "serif");
  /** A lettered word takes its light from the shot under it and its line from its whole phrase. */
  const set =
    shot && phrase
      ? {
          ...shot,
          edge: sharedEdge(
            version.cuts
              .filter((c) => c.from >= phrase.from && c.from < phrase.to)
              .map((c) => c.photo),
          ),
        }
      : undefined;
  /** Shots that carry a word are held still, so the word never moves; the others push in slowly. */
  const push = cut && !set ? (now - cut.from) / cut.duration : 0;
  /**
   * Lettered words are set small enough to leave the edge as the subject. They hold one size
   * through a phrase and step up once for the closing claim.
   */
  const climb = set ? (now >= arc.at.cascade ? 1 : 0.9) : 1;
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Grade />
      <AbsoluteFill style={{ opacity: light }}>
        {cut ? <PhotoShot photo={photoOf(cut.photo)} push={push} /> : null}
        <AbsoluteFill
          style={{
            background:
              "radial-gradient(1500px 950px at 50% 50%, transparent 52%, rgb(0 0 0 / 0.5)), linear-gradient(transparent 70%, rgb(0 0 0 / 0.25))",
          }}
        />
        <AbsoluteFill>
          {spans.map((span) => (
            <Words
              key={`${span.from}-${span.words.kind}`}
              span={span}
              now={now}
              keystrokes={version.keystrokes}
              mark={note?.mark}
              lettering={set}
              scale={climb}
              arc={arc}
            />
          ))}
        </AbsoluteFill>
        {note ? <Footnote number={note.number} text={note.text} opacity={note.opacity} /> : null}
      </AbsoluteFill>
      <Grain />
      <Audio src={staticFile(`score-${version.id}.wav`)} />
    </AbsoluteFill>
  );
}
