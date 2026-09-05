import {
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { PageLayout } from "@/book/Book";
import { PageGutter } from "@/book/PageSurface";
import { PhotoView } from "@/book/PhotoView";
import { TextView } from "@/book/TextView";
import type { Element, PageSide } from "@/domain/element";
import type { Spread } from "@/server/db/schema";

import { axisLock, clampToPage, snapMove, type Box, type Guide, type Point } from "./geometry";
import { beginGesture } from "./history";
import { photoElementFor, photoRef } from "./place";
import { useEditor, useEditorStore } from "./store";
import { TransformBox } from "./TransformBox";

export const PHOTO_DRAG_TYPE = "application/x-album-photo";
const SNAP_PX = 8;

type EditablePageProps = {
  spread: Spread;
  side: PageSide;
  layout: PageLayout;
};

type MoveGesture = {
  id: string;
  start: Box;
  origin: Point;
  /** The element node holds the capture, so click and dblclick still target it. */
  node: HTMLElement;
  pointerId: number;
  end: () => void;
};

/**
 * One page of the open spread in edit mode. Elements are clipped to the paper
 * as usual; the selection box lives in an unclipped sibling so its handles can
 * reach past the edge.
 */
export function EditablePage({ spread, side, layout }: EditablePageProps) {
  const store = useEditorStore();
  const selection = useEditor((state) => state.selection);
  const editing = useEditor((state) => state.editing);
  const select = useEditor((state) => state.select);
  const setEditing = useEditor((state) => state.setEditing);
  const updateElement = useEditor((state) => state.updateElement);
  const addElement = useEditor((state) => state.addElement);

  const rootRef = useRef<HTMLDivElement>(null);
  const move = useRef<MoveGesture | null>(null);
  const gestureEnd = useRef<(() => void) | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  // Text grows with its content, so its selection box uses the rendered height.
  const [textHeights, setTextHeights] = useState<Record<string, number>>({});
  const { pagePx, scale } = layout;

  const elements = spread.elements.filter((element) => element.page === side);
  const selected = elements.find((element) => element.id === selection);

  const toPage = (clientX: number, clientY: number): Point => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const node = elementNodeAt(event.target);
    const id = node?.dataset.element;
    if (!node || !id) {
      select(null);
      return;
    }
    if (id === editing) return;
    const element = elements.find((el) => el.id === id);
    if (!element) return;
    event.preventDefault();
    select(id);
    node.setPointerCapture(event.pointerId);
    move.current = {
      id,
      start: element,
      origin: toPage(event.clientX, event.clientY),
      node,
      pointerId: event.pointerId,
      end: beginGesture(store),
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = move.current;
    if (!g) return;
    const pointer = toPage(event.clientX, event.clientY);
    let delta = { x: pointer.x - g.origin.x, y: pointer.y - g.origin.y };
    if (event.shiftKey) delta = axisLock(delta);
    const snapped = snapMove(
      { ...g.start, x: g.start.x + delta.x, y: g.start.y + delta.y },
      SNAP_PX / scale,
    );
    const box = clampToPage(snapped.box);
    setGuides(snapped.guides);
    updateElement(spread.id, g.id, { x: box.x, y: box.y });
  };

  const onPointerUp = () => {
    const g = move.current;
    if (!g) return;
    move.current = null;
    if (g.node.hasPointerCapture(g.pointerId)) g.node.releasePointerCapture(g.pointerId);
    setGuides([]);
    g.end();
  };

  const onDoubleClick = (event: ReactPointerEvent<HTMLDivElement>) => {
    const id = elementNodeAt(event.target)?.dataset.element;
    const element = elements.find((el) => el.id === id);
    if (element?.kind === "text") setEditing(element.id);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const raw = event.dataTransfer.getData(PHOTO_DRAG_TYPE);
    if (!raw) return;
    event.preventDefault();
    const dropped: unknown = JSON.parse(raw);
    if (!photoRef.allows(dropped)) return;
    const element = photoElementFor(dropped, side, toPage(event.clientX, event.clientY));
    addElement(spread.id, element);
    select(element.id);
  };

  return (
    <div
      ref={rootRef}
      data-editable-page={side}
      className="absolute top-0"
      style={{
        left: side === "left" ? 0 : pagePx,
        width: pagePx,
        height: pagePx,
        touchAction: "none",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(PHOTO_DRAG_TYPE)) event.preventDefault();
      }}
      onDrop={onDrop}
    >
      <div className="absolute inset-0 overflow-hidden">
        {elements.map((element) =>
          element.kind === "photo" ? (
            <PhotoView key={element.id} element={element} scale={scale} />
          ) : (
            <EditableText
              key={element.id}
              element={element}
              scale={scale}
              editing={editing === element.id}
              onMeasure={(h) =>
                setTextHeights((prev) =>
                  prev[element.id] === h ? prev : { ...prev, [element.id]: h },
                )
              }
              onCommit={(text) => {
                if (text !== element.text) updateElement(spread.id, element.id, { text });
                setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
          ),
        )}
        <PageGutter side={side} />
      </div>

      {guides.map((guide) => (
        <span
          key={`${guide.axis}${guide.at}`}
          aria-hidden
          className="pointer-events-none absolute bg-primary/70"
          style={
            guide.axis === "x"
              ? { left: guide.at * scale, top: 0, width: 1, height: pagePx }
              : { top: guide.at * scale, left: 0, height: 1, width: pagePx }
          }
        />
      ))}

      {selected ? (
        <TransformBox
          key={selected.id}
          box={
            selected.kind === "text"
              ? { ...selected, h: textHeights[selected.id] ?? selected.h }
              : selected
          }
          scale={scale}
          kind={selected.kind}
          editing={editing === selected.id}
          toPage={toPage}
          onGestureStart={() => {
            move.current = null;
            gestureEnd.current = beginGesture(store);
          }}
          onGestureEnd={() => {
            gestureEnd.current?.();
            gestureEnd.current = null;
          }}
          onChange={(patch) => updateElement(spread.id, selected.id, patch)}
        />
      ) : null}
    </div>
  );
}

type EditableTextProps = {
  element: Extract<Element, { kind: "text" }>;
  scale: number;
  editing: boolean;
  onMeasure: (pageUnits: number) => void;
  onCommit: (text: string) => void;
  onCancel: () => void;
};

function EditableText({
  element,
  scale,
  editing,
  onMeasure,
  onCommit,
  onCancel,
}: EditableTextProps) {
  const ref = useRef<HTMLDivElement>(null);
  const latestMeasure = useRef(onMeasure);
  latestMeasure.current = onMeasure;

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const record = () => latestMeasure.current(node.offsetHeight / scale);
    record();
    const observer = new ResizeObserver(record);
    observer.observe(node);
    return () => observer.disconnect();
  }, [scale]);

  useLayoutEffect(() => {
    if (!editing) return;
    const node = ref.current;
    if (!node) return;
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [editing]);

  return (
    <TextView
      ref={ref}
      element={element}
      scale={scale}
      editing={editing ? { onCommit, onCancel } : undefined}
    />
  );
}

function elementNodeAt(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return null;
  if (target.closest("[data-handle]")) return null;
  return target.closest<HTMLElement>("[data-element]");
}
