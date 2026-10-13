import { cn } from "@aqt/ui/lib/utils";
import type { CSSProperties, ReactNode } from "react";

import type { PageSide } from "@/domain/element";

import { PAPER, PAPER_GRAIN } from "./materials";

type PageSurfaceProps = {
  /** Rendered page size in CSS pixels. Pages are always square. */
  sizePx: number;
  side: PageSide;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
};

/**
 * The paper: warm off-white with grain, a gutter shadow toward the spine and a
 * hairline edge. Children are laid out in absolute coordinates inside it.
 */
export function PageSurface({ sizePx, side, children, className, style }: PageSurfaceProps) {
  return (
    <div
      data-paper={side}
      className={cn("relative overflow-hidden", className)}
      style={{
        width: sizePx,
        height: sizePx,
        backgroundColor: PAPER,
        borderRadius: side === "left" ? "3px 0 0 3px" : "0 3px 3px 0",
        boxShadow: "inset 0 0 0 1px rgb(0 0 0 / .035)",
        ...style,
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: PAPER_GRAIN, opacity: 0.04, mixBlendMode: "multiply" }}
      />
      {children}
      <PageGutter side={side} />
    </div>
  );
}

/** The shadow that falls into the spine. Sits above whatever is on the page. */
export function PageGutter({ side }: { side: PageSide }) {
  const gutterSide = side === "left" ? "right" : "left";
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-0 w-[6%]"
      style={{
        [gutterSide]: 0,
        backgroundImage: `linear-gradient(to ${side}, rgb(0 0 0 / .12), rgb(0 0 0 / .03) 50%, transparent)`,
      }}
    />
  );
}
