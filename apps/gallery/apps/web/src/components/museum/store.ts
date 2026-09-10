import type { WorldLayout } from "@aqt/gallery-layout";
import { create } from "zustand";

/** Canvas element id the rig locks the pointer on and the chrome refocuses. */
export const CANVAS_ID = "museum-canvas";

export type InspectPhase = "idle" | "approaching" | "open" | "returning";

export type Vec2 = { x: number; y: number };

export type TourState = {
  active: boolean;
  paused: boolean;
  index: number;
  total: number;
  artworkId: string | null;
};

/** Imperative surface the player rig registers while mounted. The rig owns the
 * simulation (camera, walking, inspect glide, tour); the 2D chrome only ever
 * expresses intent through these and reads the mirrored state below. */
export type MuseumController = {
  engage: (isTouch: boolean) => void;
  release: () => void;
  startTour: () => void;
  endTour: () => void;
  tourNext: () => void;
  tourPrev: () => void;
  tourTogglePause: () => void;
  requestInspect: (artworkId: string) => void;
  requestCloseInspect: (resumeWalk: boolean) => void;
  teleport: (x: number, z: number) => void;
  setMoveInput: (x: number, y: number) => void;
};

type MuseumState = {
  controller: MuseumController | null;
  world: WorldLayout | null;
  /** Pointer lock active (desktop) or touch-walking engaged (mobile). */
  locked: boolean;
  /** The visitor has stepped in at least once (walk or tour). */
  entered: boolean;
  hoveredId: string | null;
  /** Which placement is hovered. An artwork may hang in more than one room, so
   * the id alone does not say which canvas the player is looking at. */
  hoveredIndex: number | null;
  inspectId: string | null;
  inspectIndex: number | null;
  inspectPhase: InspectPhase;
  roomIndex: number;
  /** Coarse-pointer device: drives touch controls instead of PointerLock. */
  isTouch: boolean;
  /** Live player position + heading for the minimap. */
  player: { x: number; z: number; angle: number };
  tourActive: boolean;
  tourPaused: boolean;
  tourIndex: number;
  tourTotal: number;
  tourArtworkId: string | null;

  // Chrome-facing intents (forwarded to the controller).
  setIsTouch: (v: boolean) => void;
  beginWalk: () => void;
  pause: () => void;
  startTour: () => void;
  stopTour: () => void;
  tourNext: () => void;
  tourPrev: () => void;
  tourTogglePause: () => void;
  openInspect: (artworkId: string) => void;
  /** `resumeWalk` re-grabs the pointer inside the closing click so desktop
   * lands back in walking instead of the paused overlay. */
  closeInspect: (resumeWalk?: boolean) => void;
  teleport: (x: number, z: number) => void;
  setMove: (v: Vec2) => void;
  reset: () => void;

  // Rig-facing mirrors (called from the simulation, never from chrome).
  setController: (controller: MuseumController | null) => void;
  setWorld: (world: WorldLayout | null) => void;
  setLocked: (locked: boolean) => void;
  markEntered: () => void;
  setHovered: (artworkId: string | null, paintingIndex: number | null) => void;
  setInspect: (artworkId: string | null, paintingIndex: number | null, phase: InspectPhase) => void;
  setRoomIndex: (index: number) => void;
  setPlayer: (x: number, z: number, angle: number) => void;
  setTour: (tour: TourState) => void;
};

const initial = {
  controller: null,
  world: null,
  locked: false,
  entered: false,
  hoveredId: null,
  hoveredIndex: null,
  inspectId: null,
  inspectIndex: null,
  inspectPhase: "idle" as InspectPhase,
  roomIndex: 0,
  isTouch: false,
  player: { x: 0, z: 0, angle: Math.PI },
  tourActive: false,
  tourPaused: false,
  tourIndex: 0,
  tourTotal: 0,
  tourArtworkId: null,
};

export const useMuseumStore = create<MuseumState>((set, get) => ({
  ...initial,

  setIsTouch: (isTouch) => set({ isTouch }),
  beginWalk: () => {
    const { controller, isTouch } = get();
    controller?.engage(isTouch);
  },
  pause: () => get().controller?.release(),
  startTour: () => get().controller?.startTour(),
  stopTour: () => get().controller?.endTour(),
  tourNext: () => get().controller?.tourNext(),
  tourPrev: () => get().controller?.tourPrev(),
  tourTogglePause: () => get().controller?.tourTogglePause(),
  openInspect: (artworkId) => get().controller?.requestInspect(artworkId),
  closeInspect: (resumeWalk = false) => get().controller?.requestCloseInspect(resumeWalk),
  teleport: (x, z) => get().controller?.teleport(x, z),
  setMove: (v) => get().controller?.setMoveInput(v.x, v.y),
  // Device class survives a reset: it is a property of the browser, not of
  // the gallery that was just left.
  reset: () => set({ ...initial, isTouch: get().isTouch }),

  setController: (controller) => set({ controller }),
  setWorld: (world) => set({ world }),
  setLocked: (locked) => set({ locked }),
  markEntered: () => {
    if (!get().entered) set({ entered: true });
  },
  setHovered: (hoveredId, hoveredIndex) => {
    if (get().hoveredIndex !== hoveredIndex) set({ hoveredId, hoveredIndex });
  },
  setInspect: (inspectId, inspectIndex, inspectPhase) =>
    set({ inspectId, inspectIndex, inspectPhase }),
  setRoomIndex: (roomIndex) => {
    if (get().roomIndex !== roomIndex) set({ roomIndex });
  },
  setPlayer: (x, z, angle) => set({ player: { x, z, angle } }),
  setTour: (tour) =>
    set({
      tourActive: tour.active,
      tourPaused: tour.paused,
      tourIndex: tour.index,
      tourTotal: tour.total,
      tourArtworkId: tour.artworkId,
    }),
}));
