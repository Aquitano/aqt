import type { CSSProperties, ReactNode } from "react";
import { motion } from "motion/react";
import type { Cover } from "@/domain/element";
import { cn } from "@/lib/utils";
import {
  BOOK_SHADOW,
  BOOK_SHADOW_LIFTED,
  PAPER_GRAIN,
  coverMaterial,
  endpaperColor,
  isLightCover,
} from "./materials";

type CoverFaceProps = {
  cover: Cover;
  title?: string;
  /** Which cover this is; decides the spine side and which corners round. */
  side: "front" | "back";
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
};

/** The outside of a cover: material, hinge shading and, on the front, the title. */
export function CoverFace({ cover, title, side, className, style, children }: CoverFaceProps) {
  const material = coverMaterial(cover);
  const light = isLightCover(cover);
  return (
    <div
      className={cn("@container relative size-full overflow-hidden", className)}
      style={{
        ...material.base,
        borderRadius: side === "front" ? "2px 6px 6px 2px" : "6px 2px 2px 6px",
        ...style,
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: material.grain.image,
          opacity: material.grain.opacity,
          mixBlendMode: material.grain.blend,
        }}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 w-[5%]",
          side === "front"
            ? "left-0 bg-gradient-to-r from-black/30 via-black/8 to-transparent"
            : "right-0 bg-gradient-to-l from-black/30 via-black/8 to-transparent",
        )}
      />
      {title ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-[3cqw] px-[10cqw] text-center"
          style={{
            color: light ? "rgb(40 30 20 / .72)" : "rgb(255 241 214 / .82)",
            textShadow: light ? "0 1px 0 rgb(255 255 255 / .35)" : "0 -1px 0 rgb(0 0 0 / .4)",
          }}
        >
          <span className="font-sans text-[5cqw] leading-tight font-medium tracking-[0.1em] uppercase">
            {title}
          </span>
          <span aria-hidden className="h-px w-[16cqw] bg-current opacity-60" />
        </div>
      ) : null}
      {children}
    </div>
  );
}

type EndpaperProps = {
  cover: Cover;
  /** Which half of the open book it sits on; the hinge shadow points at the spine. */
  side: "left" | "right";
};

/** Inside of a cover: paper tinted by the cover colour. */
export function Endpaper({ cover, side }: EndpaperProps) {
  return (
    <div
      className="relative size-full overflow-hidden"
      style={{
        backgroundColor: endpaperColor(cover),
        borderRadius: side === "left" ? "6px 2px 2px 6px" : "2px 6px 6px 2px",
        boxShadow: "inset 0 0 0 1px rgb(0 0 0 / .05)",
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: PAPER_GRAIN, opacity: 0.05, mixBlendMode: "multiply" }}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 w-[7%]",
          side === "left"
            ? "right-0 bg-gradient-to-l from-black/18 to-transparent"
            : "left-0 bg-gradient-to-r from-black/18 to-transparent",
        )}
      />
    </div>
  );
}

type ShelfCoverProps = {
  cover: Cover;
  title: string;
  className?: string;
};

/** A closed album on the shelf. Lifts on hover. */
export function ShelfCover({ cover, title, className }: ShelfCoverProps) {
  return (
    <motion.div
      className={cn("aspect-square w-full", className)}
      style={{ boxShadow: BOOK_SHADOW, borderRadius: "2px 6px 6px 2px" }}
      whileHover={{ y: -6, boxShadow: BOOK_SHADOW_LIFTED }}
      transition={{ type: "spring", stiffness: 300, damping: 24 }}
    >
      <CoverFace cover={cover} title={title} side="front" />
    </motion.div>
  );
}
