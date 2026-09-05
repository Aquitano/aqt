import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import {
  CORNERS,
  angleAround,
  normalizeAngle,
  resizeFromCorner,
  snapAngle,
  type Box,
  type Corner,
  type Point,
} from "./geometry";

type TransformBoxProps = {
  box: Box;
  /** CSS pixels per page unit. */
  scale: number;
  kind: "photo" | "text";
  /** Inline text editing hides the handles and lets clicks reach the text. */
  editing: boolean;
  toPage: (clientX: number, clientY: number) => Point;
  onGestureStart: () => void;
  onGestureEnd: () => void;
  onChange: (patch: Partial<Box>) => void;
};

const HANDLE = 10;
const ROTATE_OFFSET = 26;

type Gesture =
  | { kind: "resize"; corner: Corner; start: Box }
  | { kind: "rotate"; start: Box; startAngle: number };

/**
 * Selection ring plus resize and rotate handles, drawn in the element's own
 * rotated frame so the handles sit on its real corners. Moving is handled by
 * the page, which lets an unselected element be dragged straight away.
 */
export function TransformBox({
  box,
  scale,
  kind,
  editing,
  toPage,
  onGestureStart,
  onGestureEnd,
  onChange,
}: TransformBoxProps) {
  const gesture = useRef<Gesture | null>(null);

  const begin = (event: ReactPointerEvent<HTMLElement>, next: Gesture) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = next;
    onGestureStart();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g) return;
    const pointer = toPage(event.clientX, event.clientY);
    if (g.kind === "resize") {
      onChange(resizeFromCorner(g.start, g.corner, pointer, kind === "photo" ? "aspect" : "width"));
    } else {
      const raw = g.start.rotation + angleAround(g.start, pointer) - g.startAngle;
      onChange({ rotation: normalizeAngle(event.shiftKey ? snapAngle(raw) : raw) });
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!gesture.current) return;
    gesture.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onGestureEnd();
  };

  const handleProps = { onPointerMove, onPointerUp, onPointerCancel: onPointerUp };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12 }}
      className="pointer-events-none absolute"
      style={{
        left: box.x * scale,
        top: box.y * scale,
        width: box.w * scale,
        height: box.h * scale,
        transform: `rotate(${box.rotation}deg)`,
      }}
    >
      <div
        aria-hidden
        className={cn("ring-primary absolute inset-0 ring-[1.5px]", editing && "ring-primary/40")}
      />
      {editing ? null : (
        <>
          {CORNERS.map((corner) => (
            <span
              key={`${corner.sx}${corner.sy}`}
              data-handle={`corner-${corner.sx}-${corner.sy}`}
              className={cn(
                "pointer-events-auto absolute border border-black/25 bg-white shadow-sm",
                corner.sx === corner.sy ? "cursor-nwse-resize" : "cursor-nesw-resize",
              )}
              style={{
                width: HANDLE,
                height: HANDLE,
                left: corner.sx === -1 ? -HANDLE / 2 : undefined,
                right: corner.sx === 1 ? -HANDLE / 2 : undefined,
                top: corner.sy === -1 ? -HANDLE / 2 : undefined,
                bottom: corner.sy === 1 ? -HANDLE / 2 : undefined,
                touchAction: "none",
              }}
              onPointerDown={(event) => begin(event, { kind: "resize", corner, start: box })}
              {...handleProps}
            />
          ))}
          <span
            aria-hidden
            className="bg-primary/60 absolute left-1/2 w-px"
            style={{ top: -ROTATE_OFFSET, height: ROTATE_OFFSET }}
          />
          <span
            data-handle="rotate"
            className="pointer-events-auto absolute left-1/2 -translate-x-1/2 cursor-grab rounded-full border border-black/25 bg-white shadow-sm active:cursor-grabbing"
            style={{
              width: HANDLE + 2,
              height: HANDLE + 2,
              top: -ROTATE_OFFSET - HANDLE / 2 - 1,
              touchAction: "none",
            }}
            onPointerDown={(event) =>
              begin(event, {
                kind: "rotate",
                start: box,
                startAngle: angleAround(box, toPage(event.clientX, event.clientY)),
              })
            }
            {...handleProps}
          />
        </>
      )}
    </motion.div>
  );
}
