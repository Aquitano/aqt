import { useQuery } from "@tanstack/react-query";
import { Share2, X } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";

import { useTRPC } from "@/utils/trpc";

import { CANVAS_ID, useMuseumStore } from "./store";
import type { ArtworkData } from "./types";

/** Right-side detail panel shown while a painting is inspected.
 * The 3D camera has already glided up to the canvas; this overlays
 * the metadata without leaving the scene. */
export function InspectPanel({ artworkById }: { artworkById: Map<string, ArtworkData> }) {
  const inspectId = useMuseumStore((s) => s.inspectId);
  const phase = useMuseumStore((s) => s.inspectPhase);
  const closeInspect = useMuseumStore((s) => s.closeInspect);
  const isTouch = useMuseumStore((s) => s.isTouch);
  const trpc = useTRPC();

  const resumeWalk = () => {
    closeInspect(true);
    // Focus the canvas inside the click gesture so the rig's pointer-lock
    // re-grab lands on an active element.
    if (!isTouch) document.getElementById(CANVAS_ID)?.focus();
  };

  const visible = phase === "open";
  const mounted = phase === "open" || phase === "approaching";
  const artwork = inspectId ? (artworkById.get(inspectId) ?? null) : null;

  // The prose lives outside the whole-exhibition payload; pull it in only once a
  // work is opened. React Query caches per-id, so re-opening is instant and
  // the fetch overlaps the camera glide (approaching → open).
  const detailQuery = useQuery({
    ...trpc.exhibitions.artworkDetail.queryOptions({
      artworkId: inspectId ?? "",
    }),
    enabled: mounted && Boolean(inspectId),
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (!mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useMuseumStore.getState().inspectPhase === "open") {
        // Esc can't re-grab pointer lock (the browser reserves it), so
        // leave the visitor paused rather than resuming the walk.
        closeInspect(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mounted, closeInspect]);

  const shareLink = async () => {
    if (!inspectId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("artwork", inspectId);
    try {
      await navigator.clipboard.writeText(url.toString());
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  if (!mounted || !artwork) return null;
  const a = artwork;
  const detail = detailQuery.data;
  const facts = (detail?.funFacts ?? []).filter(Boolean);

  return (
    <div className="absolute inset-0 z-30 flex justify-end">
      {/* Click-catcher over the 3D view closes the inspect */}
      <button
        type="button"
        aria-label="Back to gallery"
        className="h-full flex-1 cursor-zoom-out bg-transparent"
        onClick={() => visible && resumeWalk()}
      />
      <aside
        className={`relative flex h-full w-full max-w-[420px] flex-col overflow-y-auto border-l border-white/10 bg-[#0e0d0bf2] px-8 py-10 text-[#e8e2d5] backdrop-blur-md transition-all duration-500 select-text ${
          visible ? "translate-x-0 opacity-100" : "translate-x-10 opacity-0"
        }`}
      >
        <button
          type="button"
          onClick={() => resumeWalk()}
          className="absolute top-5 right-5 rounded-full border border-white/15 p-2 text-white/70 transition-colors hover:border-white/40 hover:text-white"
          aria-label="Close inspection"
        >
          <X size={16} />
        </button>

        <p className="text-[11px] tracking-[0.28em] text-[#b7a989] uppercase">
          {[a.artistName, a.year].filter(Boolean).join(" · ")}
        </p>
        <h2 className="font-museum mt-3 text-4xl leading-[1.05] text-[#f4efe3]">{a.title}</h2>

        <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-white/55">
          {a.medium ? (
            <span className="rounded-full border border-white/12 px-3 py-1">{a.medium}</span>
          ) : null}
          {a.dimensions ? (
            <span className="rounded-full border border-white/12 px-3 py-1">{a.dimensions}</span>
          ) : null}
        </div>

        {detailQuery.isLoading && !detail ? (
          <div className="mt-6 space-y-2.5" aria-hidden>
            <div className="h-4 w-full animate-pulse rounded bg-white/5" />
            <div className="h-4 w-[92%] animate-pulse rounded bg-white/5" />
            <div className="h-4 w-[78%] animate-pulse rounded bg-white/5" />
          </div>
        ) : null}

        {detail?.description ? (
          <p className="mt-6 text-[15px] leading-relaxed text-white/80">{detail.description}</p>
        ) : null}

        {detail?.story ? (
          <div className="mt-7">
            <h3 className="text-[11px] tracking-[0.28em] text-[#b7a989] uppercase">The story</h3>
            <p className="mt-2.5 text-[14px] leading-relaxed text-white/70">{detail.story}</p>
          </div>
        ) : null}

        {facts.length > 0 ? (
          <div className="mt-7">
            <h3 className="text-[11px] tracking-[0.28em] text-[#b7a989] uppercase">
              Worth knowing
            </h3>
            <ul className="mt-2.5 space-y-2.5">
              {facts.map((fact) => (
                <li key={fact} className="flex gap-2.5 text-[13.5px] leading-relaxed text-white/70">
                  <span
                    aria-hidden
                    className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#b7a989]"
                  />
                  {fact}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {detail?.artistBio ? (
          <div className="mt-7 border-t border-white/10 pt-6">
            <h3 className="text-[11px] tracking-[0.28em] text-[#b7a989] uppercase">
              {a.artist?.name ?? a.artistName}
              {a.artist?.birthYear ? `, ${a.artist.birthYear}–${a.artist.deathYear ?? ""}` : ""}
            </h3>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-white/60">{detail.artistBio}</p>
          </div>
        ) : null}

        <div className="mt-9 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => resumeWalk()}
            className="rounded-full border border-[#b7a989]/50 px-5 py-2 text-[12px] tracking-[0.2em] text-[#d8cba8] uppercase transition-colors hover:bg-[#b7a989]/10"
          >
            Back to gallery
          </button>
          <button
            type="button"
            onClick={() => void shareLink()}
            className="flex items-center gap-2 rounded-full border border-white/15 px-5 py-2 text-[12px] tracking-[0.2em] text-white/70 uppercase transition-colors hover:border-white/40 hover:text-white"
          >
            <Share2 size={14} />
            Share
          </button>
        </div>
      </aside>
    </div>
  );
}
