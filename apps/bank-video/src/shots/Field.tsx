import { useLayoutEffect, useRef } from "react";

import { archive, dayOf, lane, span as archiveSpan } from "../archive";
import { centre, color, frameWidth, kindColor, kinds } from "../brand";
import { inOut, mix, ramp } from "../motion";
import type { Kind } from "../records";
import type { Span } from "../timeline";
import { height, width } from "../timeline";

export type Camera = {
  /** The day at the centre of the frame. */
  at: number;
  pxPerDay: number;
  /** Pixels between the top and bottom of the streams. */
  spread: number;
  /** 0 keeps every stream in its lane, 1 pulls them all onto the centre line. */
  converge: number;
  gain: number;
  /** A record to bracket, such as the one the shot is about. */
  focus?: { day: number; kind: Kind };
  /** A day every stream narrows into, so the whole archive flows to one point. */
  funnel?: number;
};

const transfer = { day: dayOf("2024-02-26", "18:02"), kind: "chat" } as const;

export const cameras = {
  day: { at: dayOf("2024-02-26", "15:30"), pxPerDay: frameWidth / 1.05, spread: 300 },
  month: { at: dayOf("2024-02-18"), pxPerDay: frameWidth / 34, spread: 330 },
  year: { at: dayOf("2024-03-01"), pxPerDay: frameWidth / 400, spread: 360 },
  decade: { at: archiveSpan / 2, pxPerDay: (width - 160) / archiveSpan, spread: 380 },
} satisfies Record<Span, Omit<Camera, "converge" | "gain">>;

const draw = (canvas: HTMLCanvasElement, camera: Camera) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  ctx.globalCompositeOperation = "lighter";

  const zoom = Math.log2(Math.max(camera.pxPerDay, 0.01));
  const radius = Math.min(Math.max(0.9 + zoom * 0.55, 0.85), 7);
  const alpha = Math.min(Math.max(0.3 + zoom * 0.12, 0.26), 1) * camera.gain;
  const squeeze = 1 - camera.converge;

  kinds.forEach((kind, k) => {
    const start = archive.starts[k] ?? 0;
    const end = archive.starts[k + 1] ?? archive.x.length;
    ctx.fillStyle = kindColor[kind];
    ctx.globalAlpha = Math.min(alpha, 1);
    for (let i = start; i < end; i++) {
      const sx = centre.x + ((archive.x[i] ?? 0) - camera.at) * camera.pxPerDay;
      if (camera.funnel !== undefined && (archive.x[i] ?? 0) > camera.funnel) continue;
      if (sx < -8 || sx > width + 8) continue;
      const x = archive.x[i] ?? 0;
      const narrow =
        camera.funnel === undefined
          ? 1
          : Math.min(Math.max((camera.funnel - x) / (camera.funnel * 0.7), 0), 1) ** 0.75;
      const sy = centre.y + (archive.y[i] ?? 0) * squeeze * narrow * camera.spread;
      if (radius > 2.4) {
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(sx - radius, sy - radius, radius * 2, radius * 2);
      }
    }
  });

  ctx.globalAlpha = 0.85;
  ctx.filter = "blur(9px)";
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = "none";

  if (camera.focus !== undefined) {
    const { day, kind } = camera.focus;
    const sx = centre.x + (day - camera.at) * camera.pxPerDay;
    const sy = centre.y + lane(kinds.indexOf(kind), day) * squeeze * camera.spread;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = Math.min(camera.gain, 1);
    ctx.strokeStyle = color.ink;
    ctx.lineWidth = 1.5;
    const r = 14;
    ctx.beginPath();
    ctx.moveTo(sx - r, sy - r + 6);
    ctx.lineTo(sx - r, sy - r);
    ctx.lineTo(sx - r + 6, sy - r);
    ctx.moveTo(sx + r, sy + r - 6);
    ctx.lineTo(sx + r, sy + r);
    ctx.lineTo(sx + r - 6, sy + r);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
};

export function FieldCanvas({ camera }: { camera: Camera }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    if (ref.current) draw(ref.current, camera);
  }, [camera]);
  return (
    <canvas ref={ref} width={width} height={height} style={{ position: "absolute", inset: 0 }} />
  );
}

/** One of the archive's scales, easing slowly outward over the shot. */
export function Field({ span, t, duration }: { span: Span; t: number; duration: number }) {
  const base = cameras[span];
  const out = ramp(t, 0, Math.max(duration, 24), inOut);
  const camera: Camera = {
    ...base,
    pxPerDay: base.pxPerDay * mix(1.08, 0.94, out),
    converge: 0,
    gain: span === "decade" ? 0.9 : 1,
    focus: span === "decade" ? undefined : transfer,
  };
  return <FieldCanvas camera={camera} />;
}
