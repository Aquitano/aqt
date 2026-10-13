import { Button } from "@aqt/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@aqt/ui/components/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@aqt/ui/components/sheet";
import { cn } from "@aqt/ui/lib/utils";
import { GripVertical, MoreHorizontal } from "lucide-react";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { PageElements } from "@/book/Book";
import { PageSurface } from "@/book/PageSurface";
import { pageScale } from "@/domain/page";
import type { Spread } from "@/server/db/schema";

import { useEditor } from "./store";

const THUMB_PX = 72;

type Drag = { id: string; from: number; tops: number[]; pointerId: number };

/** Left-hand sheet: every spread as a thumbnail, click to jump, drag to reorder. */
export function Filmstrip() {
  const open = useEditor((state) => state.panel === "pages");
  const setPanel = useEditor((state) => state.setPanel);
  const spreads = useEditor((state) => state.spreads);
  const current = useEditor((state) => state.current);
  const setCurrent = useEditor((state) => state.setCurrent);
  const insertSpread = useEditor((state) => state.insertSpread);
  const removeSpread = useEditor((state) => state.removeSpread);
  const reorderSpreads = useEditor((state) => state.reorderSpreads);

  const listRef = useRef<HTMLOListElement>(null);
  const drag = useRef<Drag | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);

  const ordered = order
    ? order.flatMap((id) => spreads.filter((spread) => spread.id === id))
    : spreads;

  const onGripDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    spread: Spread,
    index: number,
  ) => {
    if (event.button !== 0 || !listRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const items = Array.from(listRef.current.querySelectorAll<HTMLElement>("[data-spread]"));
    drag.current = {
      id: spread.id,
      from: index,
      tops: items.map((item) => item.getBoundingClientRect().top + item.offsetHeight / 2),
      pointerId: event.pointerId,
    };
    setDraggedId(spread.id);
    setOrder(spreads.map((s) => s.id));
  };

  const onGripMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    // Slot the dragged spread before the first item whose midpoint is below the pointer.
    let to = d.tops.findIndex((mid, i) => i !== d.from && event.clientY < mid);
    if (to === -1) to = d.tops.length;
    if (to > d.from) to -= 1;
    setOrder((prev) => {
      const ids = spreads.map((s) => s.id);
      ids.splice(d.from, 1);
      ids.splice(to, 0, d.id);
      return prev && prev.join() === ids.join() ? prev : ids;
    });
  };

  const onGripUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(d.pointerId);
    if (order && order.join() !== spreads.map((s) => s.id).join()) {
      reorderSpreads(order);
      setCurrent(order.indexOf(d.id));
    }
    setDraggedId(null);
    setOrder(null);
  };

  return (
    <Sheet open={open} onOpenChange={(next) => setPanel(next ? "pages" : null)}>
      <SheetContent side="left" className="data-[side=left]:w-full data-[side=left]:sm:max-w-xs">
        <SheetHeader>
          <SheetTitle>Pages</SheetTitle>
          <SheetDescription>Drag the grip to reorder spreads.</SheetDescription>
        </SheetHeader>
        <ol ref={listRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-6 pb-6">
          {ordered.map((spread, index) => (
            <li
              key={spread.id}
              data-spread={spread.id}
              className={cn(
                "flex items-center gap-1 rounded-lg border p-1 transition-shadow",
                spreads[current]?.id === spread.id && "ring-2 ring-primary",
                draggedId === spread.id && "shadow-lg",
              )}
            >
              <button
                type="button"
                aria-label={`Move spread ${index + 1}`}
                className="cursor-grab touch-none px-1 text-muted-foreground active:cursor-grabbing"
                onPointerDown={(event) => onGripDown(event, spread, spreads.indexOf(spread))}
                onPointerMove={onGripMove}
                onPointerUp={onGripUp}
                onPointerCancel={onGripUp}
              >
                <GripVertical className="size-4" />
              </button>
              <button
                type="button"
                className="flex flex-1 items-center gap-2 rounded-md"
                onClick={() => setCurrent(spreads.indexOf(spread))}
                aria-label={`Go to spread ${index + 1}`}
                aria-current={spreads[current]?.id === spread.id ? "true" : undefined}
              >
                <span className="w-5 text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                <span className="flex shadow-sm">
                  <PageSurface sizePx={THUMB_PX} side="left">
                    <PageElements
                      elements={spread.elements}
                      side="left"
                      scale={pageScale(THUMB_PX)}
                    />
                  </PageSurface>
                  <PageSurface sizePx={THUMB_PX} side="right">
                    <PageElements
                      elements={spread.elements}
                      side="right"
                      scale={pageScale(THUMB_PX)}
                    />
                  </PageSurface>
                </span>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Actions for spread ${index + 1}`}
                    />
                  }
                >
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => insertSpread(spreads.indexOf(spread))}>
                      Insert spread after
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={spreads.length <= 1}
                      onClick={() => removeSpread(spread.id)}
                    >
                      Delete spread
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ol>
      </SheetContent>
    </Sheet>
  );
}
