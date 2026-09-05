import { create } from "zustand";

import type { PaintingLayout } from "./layout";

export type InspectPhase = "idle" | "approaching" | "open" | "returning";

type MuseumState = {
  /** Pointer lock active — player is walking. */
  locked: boolean;
  /** Painting currently under the crosshair. */
  hovered: PaintingLayout | null;
  /** Painting being inspected, and where the animation stands. */
  inspected: PaintingLayout | null;
  inspectPhase: InspectPhase;
  /** Room index the player is currently in. */
  roomIndex: number;
  setLocked: (locked: boolean) => void;
  setHovered: (p: PaintingLayout | null) => void;
  openInspect: (p: PaintingLayout) => void;
  inspectArrived: () => void;
  closeInspect: () => void;
  inspectReturned: () => void;
  setRoomIndex: (i: number) => void;
};

export const useMuseumStore = create<MuseumState>((set) => ({
  locked: false,
  hovered: null,
  inspected: null,
  inspectPhase: "idle",
  roomIndex: 0,
  setLocked: (locked) => set({ locked }),
  setHovered: (hovered) => set({ hovered }),
  openInspect: (inspected) => set({ inspected, inspectPhase: "approaching", hovered: null }),
  inspectArrived: () => set({ inspectPhase: "open" }),
  closeInspect: () => set({ inspectPhase: "returning" }),
  inspectReturned: () => set({ inspected: null, inspectPhase: "idle" }),
  setRoomIndex: (roomIndex) => set({ roomIndex }),
}));
