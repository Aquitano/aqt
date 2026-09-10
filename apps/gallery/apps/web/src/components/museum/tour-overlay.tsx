import { ChevronLeft, ChevronRight, Info, Pause, Play, X } from "lucide-react";
import { useCallback, useEffect } from "react";

import { useMuseumStore } from "./store";
import type { ArtworkData } from "./types";

const BTN =
  "flex h-9 w-9 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent";

/** The HUD for the guided auto-tour: a caption naming the painting the camera
 * has glided to, a progress bar over the curated order, and transport controls.
 * The camera motion lives in the engine; this reads tour state from the store
 * and forwards transport commands across the bridge. */
export function TourOverlay({ artworkById }: { artworkById: Map<string, ArtworkData> }) {
  const active = useMuseumStore((s) => s.tourActive);
  const paused = useMuseumStore((s) => s.tourPaused);
  const phase = useMuseumStore((s) => s.inspectPhase);
  const index = useMuseumStore((s) => s.tourIndex);
  const count = useMuseumStore((s) => s.tourTotal);
  const artworkId = useMuseumStore((s) => s.tourArtworkId);
  const tourNext = useMuseumStore((s) => s.tourNext);
  const tourPrev = useMuseumStore((s) => s.tourPrev);
  const tourTogglePause = useMuseumStore((s) => s.tourTogglePause);
  const stopTour = useMuseumStore((s) => s.stopTour);
  const openInspect = useMuseumStore((s) => s.openInspect);

  const current = Math.min(index, Math.max(0, count - 1));
  const artwork = artworkId ? artworkById.get(artworkId) : null;

  const openDetails = useCallback(() => {
    // No explicit pause: the engine freezes the glide while an inspect is
    // open and resumes the tour when it closes (a manual pause taken before
    // opening details is preserved).
    if (artworkId) openInspect(artworkId);
  }, [artworkId, openInspect]);

  // Keyboard transport while the tour owns the view (suspended during an
  // inspect, where Escape belongs to the detail panel). The engine's own key
  // handling is disabled while this overlay is registered.
  useEffect(() => {
    if (!active || phase !== "idle") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === "Escape") {
        e.preventDefault();
        stopTour();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        tourNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        tourPrev();
      } else if (e.key === " ") {
        e.preventDefault();
        tourTogglePause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, phase, tourNext, tourPrev, tourTogglePause, stopTour]);

  if (!active || phase !== "idle" || !artwork) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col items-center gap-4 px-6 pb-8">
      <div className="max-w-xl text-center">
        <p className="text-[11px] tracking-[0.28em] text-[#b7a989] uppercase">
          {[artwork.artistName, artwork.year].filter(Boolean).join(" · ")}
        </p>
        <h2 className="font-museum mt-1.5 text-4xl leading-tight text-[#f4efe3]">
          {artwork.title}
        </h2>
        {artwork.medium ? <p className="mt-2 text-[12px] text-white/45">{artwork.medium}</p> : null}
      </div>

      <div className="flex w-full max-w-xs items-center gap-3">
        <span className="text-[11px] text-white/45 tabular-nums">{current + 1}</span>
        <div className="h-px flex-1 bg-white/15">
          <div
            className="h-full bg-[#cbb87f] transition-[width] duration-500"
            style={{ width: `${((current + 1) / Math.max(count, 1)) * 100}%` }}
          />
        </div>
        <span className="text-[11px] text-white/45 tabular-nums">{count}</span>
      </div>

      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/10 bg-black/55 px-2.5 py-1.5 backdrop-blur">
        <button
          type="button"
          onClick={tourPrev}
          disabled={current === 0}
          className={BTN}
          aria-label="Previous painting"
        >
          <ChevronLeft size={18} />
        </button>
        <button
          type="button"
          onClick={tourTogglePause}
          className={BTN}
          aria-label={paused ? "Resume tour" : "Pause tour"}
        >
          {paused ? <Play size={18} /> : <Pause size={18} />}
        </button>
        <button type="button" onClick={tourNext} className={BTN} aria-label="Next painting">
          <ChevronRight size={18} />
        </button>
        <button type="button" onClick={openDetails} className={BTN} aria-label="View details">
          <Info size={17} />
        </button>
        <div className="mx-1 h-5 w-px bg-white/12" />
        <button type="button" onClick={stopTour} className={BTN} aria-label="Exit tour">
          <X size={17} />
        </button>
      </div>

      <p className="text-[10px] tracking-[0.24em] text-white/30 uppercase">
        Space pause · ← → skip · Esc exit
      </p>
    </div>
  );
}
