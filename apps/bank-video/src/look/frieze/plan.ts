import { centre } from "../../brand";
import { beat, width } from "../../timeline";
import type { Photo } from "../Photo";
import { photos, type PhotoId } from "../photos";
import { at, durationInFrames } from "../plan";
import { sharedCuts } from "../versions";

/** Camera speed in pixels per frame: a drift while the film observes, a pan, then the rush. */
const speed = { drift: 10, pan: 25, rush: 400 } as const;

/** The drift eases into the pan just after the first join reaches the centre. */
const settle = { from: 160, to: 208 } as const;

/** Each panel's width between joins. At pan speed a join passes every bar. */
const pitch = 1600;

/** How far two neighbouring images overlap and cross-fade around their join. */
export const blend = 200;

/** How far the strip is drawn past each side of the frame: three deviations of the widest blur. */
export const overscan = 360;

const smoothstep = (t: number) => {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
};

/** In the cascade the speed grows geometrically, so each join comes a constant ratio sooner. */
const velocity = (f: number) => {
  if (f >= at.cascade) {
    return speed.pan * (speed.rush / speed.pan) ** ((f - at.cascade) / (at.aha - at.cascade));
  }
  const settled = smoothstep((f - settle.from) / (settle.to - settle.from));
  return speed.drift + (speed.pan - speed.drift) * settled;
};

/** The horizontal blur's standard deviation: none at pan speed, then about a third of a frame's travel. */
export const streak = (f: number) => (f >= at.aha ? 0 : Math.max(0, velocity(f) - speed.pan) * 0.3);

const travel = () => {
  const positions: number[] = [];
  let x = 0;
  for (let f = 0; f < at.aha; f++) {
    positions.push(Math.round(x));
    x += velocity(f);
  }
  return positions;
};

/** The world x at the centre of the screen on every frame up to the cut, in whole pixels. */
const camera = travel();
const last = camera.at(-1) ?? 0;

export const cameraAt = (f: number) => camera[Math.min(Math.max(f, 0), camera.length - 1)] ?? last;

/**
 * The first join reaches the centre late in the observation, so the score's distant note plays
 * on it. From the next one on, joins are a pitch apart and pass on the beat while the pan holds.
 */
const firstJoin = cameraAt(settle.from);
const secondJoin = cameraAt(at.pattern + 3 * beat);
const reach = last + centre.x + overscan;
const joins = [
  firstJoin,
  ...Array.from(
    { length: Math.ceil((reach - secondJoin) / pitch) + 1 },
    (_, i) => secondJoin + i * pitch,
  ),
];

/** Covers the frame's height with the line on the centre line, as `PhotoShot` scales it. */
const cover = (photo: Photo) =>
  Math.max(
    width / photo.width,
    centre.y / (photo.line * photo.height),
    centre.y / ((1 - photo.line) * photo.height),
  ) *
  1.02 *
  (photo.zoom ?? 1);

export type Panel = {
  id: PhotoId;
  photo: Photo;
  /** The joins on either side, in world x. */
  from: number;
  to: number;
  first: boolean;
  image: { left: number; top: number; width: number; height: number };
};

/** The approved order: the three opening images, then the rotation, repeated as needed. */
const order = sharedCuts.filter((c) => c.from < at.aha).map((c) => c.photo);

const panel = (index: number, from: number, to: number): Panel => {
  const id = order[index % order.length] ?? "rays";
  const photo: Photo = photos[id];
  const scale = cover(photo);
  const w = photo.width * scale;
  const h = photo.height * scale;
  const centred = (from + to) / 2 - (photo.x ?? 0.5) * w;
  return {
    id,
    photo,
    from,
    to,
    first: index === 0,
    image: {
      left: Math.min(from - blend / 2, Math.max(to + blend / 2 - w, centred)),
      top: centre.y - photo.line * h,
      width: w,
      height: h,
    },
  };
};

/** The opening image is used at its full width, so the film opens on it alone. */
const openingWidth = photos.rays.width * cover(photos.rays) - blend;

export const panels: Panel[] = [
  panel(0, firstJoin - openingWidth, firstJoin),
  ...joins.slice(0, -1).map((from, i) => panel(i + 1, from, joins[i + 1] ?? from + pitch)),
];

/** Words stand on the line in world space, centred on the ledger, the notebook and Jupiter. */
export const captions = [
  { text: "What you wrote.", at: settle.to },
  { text: "What you received.", at: at.pattern + 9 * beat },
  { text: "What you saved.", at: at.pattern + 17 * beat },
].map(({ text, at: frame }) => ({ text, x: cameraAt(frame) }));

/** The frame on which each join reaches the centre of the screen. */
const passes = joins.map((x) => camera.findIndex((c) => c >= x)).filter((f) => f > 0);
const starts = [0, ...passes, at.aha];

/** One cut per image as its join passes the centre, so the shutter clicks follow the camera. */
const cuts = [
  ...starts.slice(0, -1).map((from, i) => ({
    from,
    duration: (starts[i + 1] ?? at.aha) - from,
    photo: panels[i]?.id ?? "rays",
  })),
  { from: at.aha, duration: durationInFrames - at.aha, photo: "rays" },
];

/** What the score needs from the Frieze film. Its own motion, words and render live beside this file. */
export const frieze = { id: "frieze", cuts, keystrokes: [], stamps: [] };
