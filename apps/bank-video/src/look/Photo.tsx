import { Img, staticFile } from "remotion";

import { centre } from "../brand";
import { height, width } from "../timeline";

/** How much an image grows over its shot, anchored on its line. */
export const pushIn = 0.05;

export type Photo = {
  file: string;
  width: number;
  height: number;
  /** The dominant horizontal line's height in the image, 0 at the top and 1 at the bottom. */
  line: number;
  /** Where to centre the crop horizontally, 0 to 1. */
  x?: number;
  /** Exposure in stops, to bring every image to the same brightness before the shared grade. */
  stops?: number;
  /** How much closer than the tightest cover crop to frame it, for scans with wide margins. */
  zoom?: number;
};

/**
 * One photograph, cropped so its line sits on the screen's centre line and scaled to cover the
 * frame. The push-in is anchored on that line, so the line never moves while the image grows.
 */
export function PhotoShot({
  photo,
  push,
  y = centre.y,
}: {
  photo: Photo;
  push: number;
  /** Where on screen the image's line sits; the screen's centre line unless a shape moves it. */
  y?: number;
}) {
  const scale =
    Math.max(
      width / photo.width,
      y / (photo.line * photo.height),
      (height - y) / ((1 - photo.line) * photo.height),
    ) *
    1.02 *
    (photo.zoom ?? 1) *
    (1 + pushIn * push);
  const w = photo.width * scale;
  const h = photo.height * scale;
  const left = Math.min(0, Math.max(width - w, centre.x - (photo.x ?? 0.5) * w));
  const top = y - photo.line * h;
  const brightness = 2 ** (photo.stops ?? 0);
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <Img
        src={staticFile(`images/${photo.file}`)}
        style={{
          position: "absolute",
          left,
          top,
          width: w,
          height: h,
          filter: `brightness(${brightness}) url(#grade)`,
        }}
      />
    </div>
  );
}

/**
 * The shared grade: a lifted, warm black point, slightly muted colour and a gentle S-curve, so
 * scans, museum photographs and NASA images read as one film.
 */
export function Grade() {
  return (
    <svg width={0} height={0} style={{ position: "absolute" }}>
      <filter id="grade" colorInterpolationFilters="sRGB">
        <feColorMatrix
          type="matrix"
          values="0.88 0.10 0.02 0 0  0.05 0.88 0.07 0 0  0.03 0.10 0.80 0 0  0 0 0 1 0"
        />
        <feComponentTransfer>
          <feFuncR type="table" tableValues="0.05 0.15 0.39 0.64 0.80 0.87" />
          <feFuncG type="table" tableValues="0.045 0.14 0.37 0.62 0.78 0.85" />
          <feFuncB type="table" tableValues="0.04 0.12 0.33 0.57 0.73 0.80" />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}
