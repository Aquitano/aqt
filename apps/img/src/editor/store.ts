import { nanoid } from "nanoid";
import { createContext, useContext } from "react";
import { temporal, type TemporalState } from "zundo";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import type { Element } from "@/domain/element";
import type { Album, Spread } from "@/server/db/schema";

export type EditorMode = "view" | "edit";
export type SaveStatus = "saved" | "saving" | "error";
export type ZOrder = "forward" | "backward" | "front" | "back";
export type EditorPanel = "photos" | "pages" | null;

export type EditorState = {
  album: Album;
  spreads: Spread[];
  /** Spread index. -1 is the front cover, `spreads.length` the back cover. */
  current: number;
  mode: EditorMode;
  selection: string | null;
  /** Text element being edited inline. */
  editing: string | null;
  panel: EditorPanel;
  saveStatus: SaveStatus;

  setCurrent: (index: number) => void;
  setMode: (mode: EditorMode) => void;
  select: (id: string | null) => void;
  setEditing: (id: string | null) => void;
  setPanel: (panel: EditorPanel) => void;
  setSaveStatus: (status: SaveStatus) => void;
  updateAlbum: (patch: Partial<Pick<Album, "title" | "cover" | "shareSlug">>) => void;

  updateElement: (spreadId: string, id: string, patch: Partial<Element>) => void;
  addElement: (spreadId: string, element: Element) => void;
  removeElement: (spreadId: string, id: string) => void;
  reorderElement: (spreadId: string, id: string, to: ZOrder) => void;

  insertSpread: (after: number) => void;
  removeSpread: (id: string) => void;
  reorderSpreads: (ids: string[]) => void;
};

export type EditorStore = ReturnType<typeof createEditorStore>;

/** How many undo steps zundo keeps; gesture entries respect it too. */
export const HISTORY_LIMIT = 100;

export function createEditorStore(album: Album, spreads: Spread[]) {
  const store = createStore<EditorState>()(
    temporal(
      (set) => ({
        album,
        spreads,
        // Albums open the way a book does: closed, on the front cover.
        current: -1,
        mode: "view",
        selection: null,
        editing: null,
        panel: null,
        saveStatus: "saved",

        setCurrent: (current) =>
          set((state) => ({
            current: clampCurrent(current, state.spreads.length, state.mode),
            selection: null,
            editing: null,
          })),
        setMode: (mode) =>
          set((state) => ({
            mode,
            current: clampCurrent(state.current, state.spreads.length, mode),
            selection: null,
            editing: null,
            panel: null,
          })),
        select: (selection) => set({ selection, editing: null }),
        setEditing: (editing) => set({ editing, selection: editing }),
        setPanel: (panel) => set({ panel }),
        setSaveStatus: (saveStatus) => set({ saveStatus }),
        updateAlbum: (patch) => set((state) => ({ album: { ...state.album, ...patch } })),

        updateElement: (spreadId, id, patch) =>
          set((state) => ({
            spreads: mapElements(state.spreads, spreadId, (elements) =>
              elements.map((el) => (el.id === id ? merge(el, patch) : el)),
            ),
          })),

        addElement: (spreadId, element) =>
          set((state) => ({
            spreads: mapElements(state.spreads, spreadId, (elements) => [...elements, element]),
          })),

        removeElement: (spreadId, id) =>
          set((state) => ({
            selection: state.selection === id ? null : state.selection,
            editing: state.editing === id ? null : state.editing,
            spreads: mapElements(state.spreads, spreadId, (elements) =>
              elements.filter((el) => el.id !== id),
            ),
          })),

        reorderElement: (spreadId, id, to) =>
          set((state) => ({
            spreads: mapElements(state.spreads, spreadId, (elements) =>
              moveInArray(elements, id, to),
            ),
          })),

        insertSpread: (after) =>
          set((state) => {
            const at = Math.min(Math.max(after + 1, 0), state.spreads.length);
            const spread: Spread = {
              id: nanoid(12),
              albumId: state.album.id,
              position: at,
              elements: [],
              updatedAt: Date.now(),
            };
            return {
              spreads: reposition([
                ...state.spreads.slice(0, at),
                spread,
                ...state.spreads.slice(at),
              ]),
              current: at,
            };
          }),

        removeSpread: (id) =>
          set((state) => ({
            spreads: reposition(state.spreads.filter((s) => s.id !== id)),
          })),

        reorderSpreads: (ids) =>
          set((state) => {
            const byId = new Map(state.spreads.map((s) => [s.id, s]));
            const ordered = ids.flatMap((id) => {
              const spread = byId.get(id);
              return spread ? [spread] : [];
            });
            return { spreads: reposition(ordered) };
          }),
      }),
      {
        // Undo/redo covers page content only; navigation and mode are not history.
        partialize: (state) => ({ spreads: state.spreads }),
        equality: (past, current) => past.spreads === current.spreads,
        limit: HISTORY_LIMIT,
      },
    ),
  );

  // Any change to `spreads` can strand `current` outside the book, including
  // the ones zundo makes on undo/redo. One subscriber covers them all.
  store.subscribe((state, prev) => {
    if (state.spreads === prev.spreads) return;
    const current = clampCurrent(state.current, state.spreads.length, state.mode);
    if (current !== state.current) store.setState({ current });
  });

  return store;
}

/**
 * View mode spans the covers; edit mode only has real spreads to edit, so it
 * clamps onto the nearest one.
 */
function clampCurrent(index: number, count: number, mode: EditorMode) {
  if (mode === "view") return Math.min(Math.max(index, -1), count);
  if (count === 0) return -1;
  return Math.min(Math.max(index, 0), count - 1);
}

const EditorStoreContext = createContext<EditorStore | null>(null);

export const EditorStoreProvider = EditorStoreContext.Provider;

/** The raw store, for imperative reads and zundo access. */
export function useEditorStore(): EditorStore {
  const store = useContext(EditorStoreContext);
  if (!store) throw new Error("useEditorStore must be used inside EditorStoreProvider");
  return store;
}

export function useEditor<T>(selector: (state: EditorState) => T): T {
  const store = useContext(EditorStoreContext);
  if (!store) throw new Error("useEditor must be used inside EditorStoreProvider");
  return useStore(store, selector);
}

/** Undo/redo controls for the current album, backed by zundo. */
export function useEditorTemporal<T>(
  selector: (state: TemporalState<Pick<EditorState, "spreads">>) => T,
): T {
  const store = useContext(EditorStoreContext);
  if (!store) throw new Error("useEditor must be used inside EditorStoreProvider");
  return useStore(store.temporal, selector);
}

function merge<T extends Element>(element: T, patch: Partial<T>): T {
  return { ...element, ...patch };
}

function mapElements(
  spreads: Spread[],
  spreadId: string,
  fn: (elements: Element[]) => Element[],
): Spread[] {
  return spreads.map((spread) =>
    spread.id === spreadId ? { ...spread, elements: fn(spread.elements) } : spread,
  );
}

/**
 * Array order is z-order: last element is topmost. Steps only pass elements on
 * the same page, since the other page never overlaps this one.
 */
function moveInArray(elements: Element[], id: string, to: ZOrder): Element[] {
  const from = elements.findIndex((el) => el.id === id);
  if (from === -1) return elements;
  const peers = elements.flatMap((el, index) => (el.page === elements[from].page ? [index] : []));
  const at = peers.indexOf(from);
  const target =
    to === "front"
      ? peers[peers.length - 1]
      : to === "back"
        ? peers[0]
        : to === "forward"
          ? peers[Math.min(at + 1, peers.length - 1)]
          : peers[Math.max(at - 1, 0)];
  if (target === from) return elements;
  const next = [...elements];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

function reposition(spreads: Spread[]): Spread[] {
  return spreads.map((spread, position) =>
    spread.position === position ? spread : { ...spread, position },
  );
}
