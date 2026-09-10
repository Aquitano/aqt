import { env } from "@aqt/gallery-env/web";
import { useEffect } from "react";

import { useMuseumStore } from "./store";

export type StatEntityKind = "exhibition";
export type StatMetric = "page_view" | "session_entered" | "inspect_open" | "tour_completed";

export type VisitEvent = {
  entityKind: StatEntityKind;
  entityId: string;
  metric: StatMetric;
  artworkId?: string;
};

const ENDPOINT = `${env.VITE_SERVER_URL}/beacon/stats`;
/** Flush eagerly once a walkthrough has accrued this many events, so a long
 * session that never hides the tab still reports before it grows unbounded. */
const FLUSH_THRESHOLD = 12;

let queue: VisitEvent[] = [];

function send(events: VisitEvent[]) {
  if (events.length === 0) return;
  // text/plain keeps the beacon a CORS-simple request (no preflight, which
  // sendBeacon cannot perform); the server parses the body as JSON regardless.
  const blob = new Blob([JSON.stringify({ events })], { type: "text/plain" });
  navigator.sendBeacon?.(ENDPOINT, blob);
}

export function flushVisitEvents() {
  const batch = queue;
  queue = [];
  send(batch);
}

export function trackVisitEvent(event: VisitEvent) {
  queue.push(event);
  if (queue.length >= FLUSH_THRESHOLD) flushVisitEvents();
}

/** Emit anonymous, aggregate-only visit events for a public walkthrough:
 * a page view on mount, the first session enter, each artwork inspect, and the
 * tour reaching its final work. Does nothing unless `enabled` — the public
 * route disables it for draft previews and for the owner's own visits, so a
 * curator refreshing their gallery doesn't inflate its numbers. Events are
 * batched and flushed on tab-hide / unmount via {@link flushVisitEvents}. */
export function useVisitAnalytics(
  entityKind: StatEntityKind,
  entityId: string | null,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled || !entityId) return;

    const track = (metric: StatMetric, artworkId?: string) =>
      trackVisitEvent({ entityKind, entityId, metric, artworkId });

    track("page_view");

    // The tour exposes no explicit "finished" signal, so completion is counted
    // once the guided camera reaches the final work in a given tour run.
    let tourCompleted = false;
    const unsubscribe = useMuseumStore.subscribe((state, prev) => {
      if (state.entered && !prev.entered) track("session_entered");
      if (state.inspectId && state.inspectId !== prev.inspectId) {
        track("inspect_open", state.inspectId);
      }
      if (state.tourActive && !prev.tourActive) tourCompleted = false;
      if (
        state.tourActive &&
        state.tourTotal > 0 &&
        state.tourIndex >= state.tourTotal - 1 &&
        !tourCompleted
      ) {
        tourCompleted = true;
        track("tour_completed");
      }
    });

    const flushOnHide = () => {
      if (document.visibilityState === "hidden") flushVisitEvents();
    };
    document.addEventListener("visibilitychange", flushOnHide);
    window.addEventListener("pagehide", flushVisitEvents);

    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", flushOnHide);
      window.removeEventListener("pagehide", flushVisitEvents);
      flushVisitEvents();
    };
  }, [entityKind, entityId, enabled]);
}
