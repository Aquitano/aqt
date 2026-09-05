import { useState, type CSSProperties } from "react";
import { ImageOff } from "lucide-react";
import type { PhotoElement } from "@/domain/element";
import { photoUrl } from "@/lib/image";

type PhotoViewProps = {
  element: PhotoElement;
  /** CSS pixels per page unit. */
  scale: number;
};

const PHOTO_SHADOW = "0 1px 2px rgb(0 0 0 / .14), 0 4px 12px rgb(0 0 0 / .10)";
const MATTE = "oklch(0.995 0.003 90)";
const CORNER = "oklch(0.24 0.01 60)";
const TAPE = "rgb(252 247 232 / .74)";

/** A photo with its frame. `w`/`h` are the full footprint, frame included. */
export function PhotoView({ element, scale }: PhotoViewProps) {
  const w = element.w * scale;
  const h = element.h * scale;
  const box: CSSProperties = {
    position: "absolute",
    left: element.x * scale,
    top: element.y * scale,
    width: w,
    height: h,
    transform: `rotate(${element.rotation}deg)`,
  };

  switch (element.frame) {
    case "polaroid": {
      const pad = w * 0.05;
      return (
        <div
          data-element={element.id}
          style={{
            ...box,
            backgroundColor: MATTE,
            padding: `${pad}px ${pad}px ${w * 0.14}px`,
            boxShadow: `${PHOTO_SHADOW}, inset 0 0 0 1px rgb(0 0 0 / .04)`,
          }}
        >
          <Picture photoId={element.photoId} />
        </div>
      );
    }
    case "corners": {
      const size = Math.max(10, Math.min(w, h) * 0.08);
      return (
        <div data-element={element.id} style={{ ...box, boxShadow: PHOTO_SHADOW }}>
          <Picture photoId={element.photoId} />
          {CORNER_CLIPS.map(([name, clip, pos]) => (
            <span
              key={name}
              aria-hidden
              className="absolute"
              style={{ ...pos, width: size, height: size, clipPath: clip, backgroundColor: CORNER }}
            />
          ))}
        </div>
      );
    }
    case "tape": {
      const strip: CSSProperties = {
        position: "absolute",
        width: w * 0.3,
        height: Math.max(10, Math.min(w, h) * 0.07),
        top: 0,
        backgroundColor: TAPE,
        boxShadow: "inset 0 0 0 1px rgb(255 255 255 / .3), 0 1px 2px rgb(0 0 0 / .1)",
      };
      return (
        <div data-element={element.id} style={{ ...box, boxShadow: "0 1px 2px rgb(0 0 0 / .1)" }}>
          <Picture photoId={element.photoId} />
          <span
            aria-hidden
            style={{ ...strip, left: w * 0.03, transform: "translateY(-50%) rotate(-6deg)" }}
          />
          <span
            aria-hidden
            style={{ ...strip, right: w * 0.03, transform: "translateY(-50%) rotate(6deg)" }}
          />
        </div>
      );
    }
    default:
      return (
        <div data-element={element.id} style={{ ...box, boxShadow: PHOTO_SHADOW }}>
          <Picture photoId={element.photoId} />
          <span aria-hidden className="absolute inset-0 shadow-[inset_0_0_0_1px_rgb(0_0_0/.06)]" />
        </div>
      );
  }
}

const CORNER_CLIPS = [
  ["tl", "polygon(0 0, 100% 0, 0 100%)", { top: 0, left: 0 }],
  ["tr", "polygon(0 0, 100% 0, 100% 100%)", { top: 0, right: 0 }],
  ["bl", "polygon(0 0, 0 100%, 100% 100%)", { bottom: 0, left: 0 }],
  ["br", "polygon(100% 0, 100% 100%, 0 100%)", { bottom: 0, right: 0 }],
] as const satisfies readonly [string, string, CSSProperties][];

function Picture({ photoId }: { photoId: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="bg-muted text-muted-foreground flex size-full items-center justify-center">
        <ImageOff className="size-1/4 opacity-50" />
      </div>
    );
  }
  return (
    <img
      src={photoUrl(photoId, "display")}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
      className="block size-full object-cover select-none"
    />
  );
}
