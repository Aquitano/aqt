import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Link } from "@tanstack/react-router";
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";

import { InspectPanel } from "./inspect-panel";
import { Minimap } from "./minimap";
import { CAMERA_FAR } from "./renderer/constants";
import { buildMuseumWorld } from "./renderer/content";
import { type AutopilotPose, PlayerRig } from "./renderer/player-rig";
import { GalleryScene } from "./renderer/scene";
import { CANVAS_ID, useMuseumStore } from "./store";
import { resolveTheme } from "./theme";
import { TouchJoystick } from "./touch-controls";
import { TourOverlay } from "./tour-overlay";
import type { ArtworkData, GalleryContent } from "./types";

function Crosshair() {
  const locked = useMuseumStore((s) => s.locked);
  const hoveredId = useMuseumStore((s) => s.hoveredId);
  const isTouch = useMuseumStore((s) => s.isTouch);
  const phase = useMuseumStore((s) => s.inspectPhase);
  // Touch aims by tapping a painting, not a fixed crosshair.
  if (!locked || isTouch || phase !== "idle") return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div
        className={`rounded-full border transition-all duration-200 ${
          hoveredId ? "h-5 w-5 border-[#e9d9ad]" : "h-1.5 w-1.5 border-white/60 bg-white/40"
        }`}
      />
    </div>
  );
}

function HoverTitle({ artworkById }: { artworkById: Map<string, ArtworkData> }) {
  const hoveredId = useMuseumStore((s) => s.hoveredId);
  const locked = useMuseumStore((s) => s.locked);
  const hovered = hoveredId ? artworkById.get(hoveredId) : null;
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-24 z-10 flex justify-center transition-all duration-300 ${
        hovered && locked ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      }`}
    >
      <div className="rounded-full border border-white/10 bg-black/55 px-5 py-2.5 text-center backdrop-blur">
        <p className="font-museum text-lg leading-tight text-[#f1ead9]">{hovered?.title}</p>
        <p className="text-[11px] tracking-[0.22em] text-white/50 uppercase">
          {hovered?.artistName} — click to inspect
        </p>
      </div>
    </div>
  );
}

function RoomIndicator({ content }: { content: GalleryContent }) {
  const roomIndex = useMuseumStore((s) => s.roomIndex);
  const locked = useMuseumStore((s) => s.locked);
  const tourActive = useMuseumStore((s) => s.tourActive);
  const phase = useMuseumStore((s) => s.inspectPhase);
  const world = useMuseumStore((s) => s.world);
  // The world's room list carries the auto-split wing names ("… · II");
  // the raw content is only the pre-mount fallback.
  const room =
    world?.rooms[roomIndex] ?? content.rooms.filter((r) => r.artworks.length > 0)[roomIndex];
  return (
    <div
      className={`pointer-events-none absolute top-6 left-6 z-10 transition-opacity duration-500 ${
        (locked || tourActive) && phase === "idle" ? "opacity-100" : "opacity-0"
      }`}
    >
      <p className="text-[10px] tracking-[0.3em] text-white/45 uppercase">{content.name}</p>
      <p className="font-museum mt-1 text-2xl text-[#ece5d3]">{room?.name ?? ""}</p>
    </div>
  );
}

function ControlsHint() {
  const locked = useMuseumStore((s) => s.locked);
  const isTouch = useMuseumStore((s) => s.isTouch);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!locked) return;
    setExpired(false);
    const t = setTimeout(() => setExpired(true), 7000);
    return () => clearTimeout(t);
  }, [locked]);
  return (
    <div
      className={`pointer-events-none absolute bottom-6 left-1/2 z-10 -translate-x-1/2 text-center text-[11px] leading-5 text-white/45 transition-opacity duration-700 ${
        locked && !expired ? "opacity-100" : "opacity-0"
      }`}
    >
      {isTouch ? (
        <>
          <p>Joystick — walk · Drag — look</p>
          <p>Tap a painting — inspect · Map — teleport</p>
        </>
      ) : (
        <>
          <p>WASD — walk · Shift — stride · T — guided tour</p>
          <p>Mouse — look · Click — inspect · Esc — pause</p>
        </>
      )}
    </div>
  );
}

/** Touch start for the guided tour. Desktop drives it with the `T` key (the
 * pointer is locked while walking, so an on-screen button can't be clicked);
 * touch has no lock, so a tap target is the natural entry point. */
function TourStartButton() {
  const isTouch = useMuseumStore((s) => s.isTouch);
  const locked = useMuseumStore((s) => s.locked);
  const tourActive = useMuseumStore((s) => s.tourActive);
  const phase = useMuseumStore((s) => s.inspectPhase);
  const startTour = useMuseumStore((s) => s.startTour);
  if (!isTouch || !locked || tourActive || phase !== "idle") return null;
  return (
    <button
      type="button"
      onClick={startTour}
      className="pointer-events-auto absolute top-6 left-1/2 z-30 -translate-x-1/2 rounded-full border border-[#cbb87f]/40 bg-black/45 px-5 py-2 text-[11px] tracking-[0.24em] text-[#e9dcb4] uppercase backdrop-blur transition-colors hover:bg-[#cbb87f]/15"
    >
      ▶ Guided tour
    </button>
  );
}

/** Touch has no Esc; a tap target returns to the paused overlay. */
function TouchPauseButton() {
  const isTouch = useMuseumStore((s) => s.isTouch);
  const locked = useMuseumStore((s) => s.locked);
  const phase = useMuseumStore((s) => s.inspectPhase);
  const pause = useMuseumStore((s) => s.pause);
  if (!isTouch || !locked || phase !== "idle") return null;
  return (
    <button
      type="button"
      aria-label="Pause"
      onClick={pause}
      className="pointer-events-auto absolute right-6 bottom-8 z-30 flex h-12 w-12 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white/70 backdrop-blur-sm"
    >
      <span className="text-lg leading-none">❚❚</span>
    </button>
  );
}

function EnterOverlay({
  content,
  ready,
  onWalk,
  onTour,
}: {
  content: GalleryContent;
  ready: boolean;
  onWalk: () => void;
  onTour: () => void;
}) {
  const locked = useMuseumStore((s) => s.locked);
  const phase = useMuseumStore((s) => s.inspectPhase);
  const isTouch = useMuseumStore((s) => s.isTouch);
  const tourActive = useMuseumStore((s) => s.tourActive);
  const entered = useMuseumStore((s) => s.entered);
  if (locked || phase !== "idle" || tourActive) return null;

  if (entered) {
    return (
      <>
        <button
          type="button"
          onClick={onWalk}
          className="absolute inset-0 z-20 flex w-full cursor-pointer flex-col items-center justify-center bg-black/35 backdrop-blur-[2px] transition-opacity"
        >
          <p className="font-museum text-3xl text-[#efe8d6]">Paused</p>
          <p className="mt-3 text-[12px] tracking-[0.28em] text-white/55 uppercase">
            {isTouch ? "Tap to continue walking" : "Click to continue walking"}
          </p>
        </button>
        <button
          type="button"
          onClick={onTour}
          className="absolute bottom-24 left-1/2 z-20 -translate-x-1/2 rounded-full border border-[#cbb87f]/50 bg-black/40 px-6 py-2.5 text-[11px] tracking-[0.28em] text-[#e9dcb4] uppercase backdrop-blur transition-all hover:bg-[#cbb87f]/20"
        >
          ▶ Take the guided tour
        </button>
      </>
    );
  }

  const roomsWithArt = content.rooms.filter((r) => r.artworks.length > 0);
  const artworkCount = roomsWithArt.reduce((acc, r) => acc + r.artworks.length, 0);

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-gradient-to-b from-black/70 via-black/55 to-black/80 px-6 text-center">
      <p className="text-[11px] tracking-[0.34em] text-[#b7a989] uppercase">
        {content.tagline ?? "A walkable gallery"}
      </p>
      <h1 className="font-museum mt-4 max-w-3xl text-6xl leading-[1.02] text-[#f4efe3] md:text-7xl">
        {content.name}
      </h1>
      {content.description ? (
        <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-white/65">
          {content.description}
        </p>
      ) : null}
      <p className="mt-5 text-[11px] tracking-[0.24em] text-white/40 uppercase">
        {roomsWithArt.length} {roomsWithArt.length === 1 ? "room" : "rooms"} · {artworkCount}{" "}
        artworks
      </p>
      <button
        type="button"
        onClick={onWalk}
        disabled={!ready}
        className="group mt-10 rounded-full border border-[#cbb87f]/60 bg-[#cbb87f]/10 px-10 py-4 text-[13px] tracking-[0.3em] text-[#e9dcb4] uppercase transition-all hover:bg-[#cbb87f]/25 hover:tracking-[0.36em] disabled:cursor-wait disabled:opacity-60"
      >
        {ready ? "Enter the gallery" : "Preparing…"}
      </button>
      <button
        type="button"
        onClick={onTour}
        disabled={!ready}
        className="mt-4 text-[11px] tracking-[0.28em] text-white/45 uppercase underline-offset-4 transition-colors hover:text-[#e9dcb4] hover:underline disabled:opacity-50"
      >
        ▶ Or take the guided tour
      </button>
      <p className="mt-6 text-[11px] text-white/35">
        {isTouch
          ? "Joystick to walk · drag to look · tap a painting to inspect"
          : "WASD to walk · mouse to look · click a painting to inspect"}
      </p>
      <Link
        to="/museum"
        className="mt-10 text-[11px] tracking-[0.24em] text-white/40 uppercase underline-offset-4 transition-colors hover:text-white/80 hover:underline"
      >
        ← Back to the lobby
      </Link>
    </div>
  );
}

function MuseumNotice({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center bg-[#0b0a09] px-6 text-center">
      <p className="font-museum text-4xl text-[#e8e2d5]">{title}</p>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-white/50">{body}</p>
      <Link
        to="/museum"
        className="mt-8 rounded-full border border-white/20 px-6 py-2.5 text-[12px] tracking-[0.24em] text-white/70 uppercase transition-colors hover:border-white/50 hover:text-white"
      >
        Back to the lobby
      </Link>
    </div>
  );
}

/** R3F rethrows anything the scene throws (shader compile, lost context,
 * bad geometry) into the nearest DOM boundary; this one hands the failure to
 * the host so it can swap the whole experience for a notice. */
class CanvasBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("museum renderer failed", error);
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export type FrameStats = {
  drawCalls: number;
  triangles: number;
  lights: number;
};

/** Reports the previous frame's renderer counters (dev harness / CI budget).
 * Default priority: a positive one would hand rendering over to us. */
function FrameStatsProbe({ onStats }: { onStats: (s: FrameStats) => void }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useFrame(() => {
    let lights = 0;
    scene.traverseVisible((o) => {
      if ((o as THREE.Light).isLight) lights++;
    });
    onStats({
      drawCalls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      lights,
    });
  });
  return null;
}

export function MuseumExperience({
  content,
  deepLinkArtworkId,
  autopilot,
  onFrameStats,
}: {
  content: GalleryContent;
  deepLinkArtworkId?: string;
  /** Dev harness only: start walking at a fixed pose without pointer lock. */
  autopilot?: AutopilotPose;
  /** Dev harness only: renderer counters per frame. */
  onFrameStats?: (stats: FrameStats) => void;
}) {
  const [ready, setReady] = useState(false);
  const [renderFailed, setRenderFailed] = useState(false);
  const deepLinkApplied = useRef(false);

  const hasArtworks = content.rooms.some((r) => r.artworks.length > 0);
  const museum = useMemo(
    () => (hasArtworks ? buildMuseumWorld(content) : null),
    [content, hasArtworks],
  );
  const theme = useMemo(() => resolveTheme(content.theme), [content.theme]);

  // Touch controls only when the *primary* pointer is coarse (phone/tablet).
  // A touchscreen laptop driven by a mouse reports maxTouchPoints > 0 but a
  // fine primary pointer, and must keep the pointer-lock/WASD desktop path.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const coarse = window.matchMedia?.("(pointer: coarse)");
    const touch = coarse ? coarse.matches : navigator.maxTouchPoints > 0;
    useMuseumStore.getState().setIsTouch(touch);
  }, []);

  useEffect(() => () => useMuseumStore.getState().reset(), []);

  // Deep link: once the rig is up, drop the visitor in front of the shared
  // painting with its inspect open, skipping the entrance. An unknown id
  // silently leaves the normal entrance in place.
  const controller = useMuseumStore((s) => s.controller);
  useEffect(() => {
    if (!controller || !deepLinkArtworkId || deepLinkApplied.current) return;
    deepLinkApplied.current = true;
    const painting = museum?.world.paintings.find((p) => p.artworkId === deepLinkArtworkId);
    if (!painting) return;
    const { teleport, openInspect } = useMuseumStore.getState();
    teleport(
      painting.position[0] + painting.normal[0] * 2.5,
      painting.position[2] + painting.normal[2] * 2.5,
    );
    openInspect(deepLinkArtworkId);
  }, [controller, deepLinkArtworkId, museum]);

  // Keep the address bar shareable: mirror the open inspect into ?artwork=<id>
  // and drop it on close. replaceState avoids a router navigation, so this never
  // re-renders the route or feeds back into the deep-link effect above.
  const inspectId = useMuseumStore((s) => s.inspectId);
  const inspectPhase = useMuseumStore((s) => s.inspectPhase);
  useEffect(() => {
    const inspecting = inspectPhase === "approaching" || inspectPhase === "open";
    const url = new URL(window.location.href);
    if (inspecting && inspectId) {
      url.searchParams.set("artwork", inspectId);
    } else {
      url.searchParams.delete("artwork");
    }
    window.history.replaceState(window.history.state, "", url);
  }, [inspectId, inspectPhase]);

  const beginWalk = useCallback(() => {
    document.getElementById(CANVAS_ID)?.focus();
    useMuseumStore.getState().beginWalk();
  }, []);

  const beginTour = useCallback(() => {
    document.getElementById(CANVAS_ID)?.focus();
    useMuseumStore.getState().startTour();
  }, []);

  if (!museum) {
    return (
      <MuseumNotice
        title="The walls are bare"
        body="This gallery has no published artworks yet. Check back when the curators have finished hanging the collection."
      />
    );
  }

  if (renderFailed) {
    return (
      <MuseumNotice
        title="The gallery could not be rendered"
        body="Your browser could not start the 3D view. Reload the page to try again, or check that hardware acceleration is enabled."
      />
    );
  }

  const { world, artworkById } = museum;

  return (
    <div className="relative h-screen w-full touch-none overflow-hidden bg-[#0b0a09] select-none">
      <CanvasBoundary onError={() => setRenderFailed(true)}>
        <Canvas
          frameloop="demand"
          shadows={{ enabled: true, type: THREE.PCFShadowMap }}
          camera={{ fov: 70, near: 0.1, far: CAMERA_FAR }}
          dpr={[1, 1.5]}
          gl={{
            antialias: true,
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.12,
            powerPreference: "high-performance",
          }}
          onCreated={({ gl }) => {
            // The only shadow casters are static geometry lit by the room
            // light pool, which moves solely on a room change. Re-baking all
            // shadow maps every frame is the bulk of the idle CPU cost on a
            // large gallery, so bake on demand: the lights flip needsUpdate
            // when they reposition.
            gl.shadowMap.autoUpdate = false;
            gl.shadowMap.needsUpdate = true;
            gl.domElement.id = CANVAS_ID;
            gl.domElement.tabIndex = 0;
            gl.domElement.classList.add("outline-none");
            setReady(true);
          }}
        >
          <GalleryScene world={world} artworkById={artworkById} theme={theme} />
          <PlayerRig world={world} autopilot={autopilot} />
          {onFrameStats ? <FrameStatsProbe onStats={onFrameStats} /> : null}
        </Canvas>
      </CanvasBoundary>

      <Crosshair />
      <HoverTitle artworkById={artworkById} />
      <RoomIndicator content={content} />
      <ControlsHint />
      <Minimap />
      <TouchJoystick />
      <TouchPauseButton />
      <TourStartButton />
      <TourOverlay artworkById={artworkById} />
      <InspectPanel artworkById={artworkById} />
      <EnterOverlay content={content} ready={ready} onWalk={beginWalk} onTour={beginTour} />
    </div>
  );
}

export default MuseumExperience;
