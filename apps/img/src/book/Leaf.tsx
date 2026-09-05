import { motion, useTransform, type MotionValue } from "motion/react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";

export type SpineAt = "center" | "left";

type LeafProps = {
  sheet: number;
  /** Total turnable sheets, for z-ordering. */
  sheetCount: number;
  progress: MotionValue<number>;
  spineAt: SpineAt;
  width: number;
  height: number;
  /** Vertical offset relative to the page block; covers overhang. */
  top?: number;
  front: ReactNode;
  back: ReactNode;
  reduced: boolean;
  /** Layered box-shadow applied to both faces, for covers. */
  shadow?: string;
  grabbable?: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
};

/**
 * One sheet of the book. It hinges on the spine: the front face is what you see
 * while it lies on the right stack, the back face once it has been turned to
 * the left. Both faces live in the same 3D box; the back face is pre-rotated by
 * 180deg so that after the sheet turns, its content reads the right way round.
 */
export function Leaf({
  sheet,
  sheetCount,
  progress,
  spineAt,
  width,
  height,
  top = 0,
  front,
  back,
  reduced,
  shadow,
  grabbable = false,
  onPointerDown,
}: LeafProps) {
  const rotateY = useTransform(progress, (p) => (reduced ? (p < 0.5 ? 0 : -180) : -180 * p));
  const opacity = useTransform(progress, (p) => (reduced ? Math.abs(1 - 2 * p) : 1));
  // Resting sheets stack naturally; a moving sheet floats above everything.
  const zIndex = useTransform(progress, (p) =>
    p <= 0.001 ? sheetCount - sheet : p >= 0.999 ? sheet : 2 * sheetCount + sheet,
  );
  const shadowZ = useTransform(zIndex, (z) => z - 1);
  const lift = useTransform(progress, (p) => Math.sin(p * Math.PI));
  const shade = useTransform(lift, (l) => l * 0.9);
  const underShadow = useTransform(lift, (l) => l * 0.35);
  const liftShadow = useTransform(
    lift,
    (l) =>
      `0 ${(4 + 14 * l).toFixed(1)}px ${(12 + 36 * l).toFixed(1)}px rgb(0 0 0 / ${(0.06 + 0.22 * l).toFixed(3)})`,
  );

  const face: CSSProperties = { position: "absolute", inset: 0, backfaceVisibility: "hidden" };

  return (
    <>
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          zIndex: shadowZ,
          opacity: underShadow,
          backgroundImage:
            spineAt === "center"
              ? "linear-gradient(to right, transparent 18%, rgb(0 0 0) 50%, transparent 82%)"
              : "linear-gradient(to right, rgb(0 0 0), transparent 64%)",
        }}
      />
      <motion.div
        data-sheet={sheet}
        onPointerDown={onPointerDown}
        className={grabbable ? "cursor-grab" : undefined}
        style={{
          position: "absolute",
          top,
          left: spineAt === "center" ? "50%" : 0,
          width,
          height,
          transformOrigin: "left center",
          transformStyle: "preserve-3d",
          willChange: "transform",
          rotateY,
          opacity,
          zIndex,
          touchAction: "none",
        }}
      >
        <motion.div style={{ ...face, boxShadow: shadow ?? liftShadow }}>
          {front}
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              opacity: shade,
              backgroundImage:
                "linear-gradient(to right, rgb(0 0 0 / .30), rgb(0 0 0 / .06) 30%, rgb(255 255 255 / .12) 60%, rgb(0 0 0 / .16))",
            }}
          />
        </motion.div>
        <motion.div
          style={{ ...face, transform: "rotateY(180deg)", boxShadow: shadow ?? liftShadow }}
        >
          {back}
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              opacity: shade,
              backgroundImage:
                "linear-gradient(to left, rgb(0 0 0 / .30), rgb(0 0 0 / .06) 30%, rgb(255 255 255 / .12) 60%, rgb(0 0 0 / .16))",
            }}
          />
        </motion.div>
      </motion.div>
    </>
  );
}
