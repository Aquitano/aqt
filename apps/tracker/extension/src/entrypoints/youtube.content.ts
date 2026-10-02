import { type } from "arktype";
import { defineContentScript } from "wxt/utils/define-content-script";

import { TRANSCRIPT_EVENT, TRANSCRIPT_REQUEST_EVENT, type Transcript } from "../lib/transcript.ts";
import { LoadedTranscript, TranscriptPanel, preferredTrack, track } from "../lib/youtube.ts";

type GetTranscriptCommand = {
  commandMetadata: { webCommandMetadata: { sendPost: true; apiUrl: string } };
  getTranscriptEndpoint: { params: string };
};

declare global {
  interface HTMLElementTagNameMap {
    "ytd-app": HTMLElement & { resolveCommand?: (command: GetTranscriptCommand) => void };
  }
}

const PANEL_SELECTOR =
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';
const POLL_MS = 100;
const WAIT_MS = 4000;

function loaded(panel: Element, videoId: string): LoadedTranscript | undefined {
  const element = panel.querySelector("ytd-transcript-search-panel-renderer");
  if (!element || !("data" in element)) return undefined;
  const decoded = LoadedTranscript(element.data);
  if (decoded instanceof type.errors) return undefined;
  return decoded.tracks.some((candidate) => candidate.selected && candidate.videoId === videoId)
    ? decoded
    : undefined;
}

// Asking YouTube's own app for the transcript is what "Show transcript" does:
// the request carries the attestation YouTube demands and the panel stays hidden.
function load(params: string): void {
  document.querySelector("ytd-app")?.resolveCommand?.({
    commandMetadata: {
      webCommandMetadata: { sendPost: true, apiUrl: "/youtubei/v1/get_transcript" },
    },
    getTranscriptEndpoint: { params },
  });
}

function waitFor<T>(read: () => T | undefined, deadline: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const poll = () => {
      const value = read();
      if (value !== undefined || Date.now() >= deadline) resolve(value);
      else setTimeout(poll, POLL_MS);
    };
    poll();
  });
}

async function currentTranscript(): Promise<Transcript | undefined> {
  const videoId = new URL(location.href).searchParams.get("v");
  const panel = document.querySelector(PANEL_SELECTOR);
  if (!videoId || !panel) return undefined;
  const deadline = Date.now() + WAIT_MS;
  let state = loaded(panel, videoId);
  // Loading a track into a panel the user has open would switch what they read.
  if (panel.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN") {
    if (!state) {
      const endpoint = TranscriptPanel("data" in panel ? panel.data : undefined);
      if (endpoint instanceof type.errors) return undefined;
      const params =
        endpoint.content.continuationItemRenderer.continuationEndpoint.getTranscriptEndpoint.params;
      if (track(params).videoId !== videoId) return undefined;
      load(params);
      state = await waitFor(() => loaded(panel, videoId), deadline);
    }
    const best = state && preferredTrack(state.tracks, document.documentElement.lang);
    if (state && best && !(best.selected && state.segments.length > 0)) {
      load(best.params);
      state = await waitFor(() => {
        const next = loaded(panel, videoId);
        const selected = next?.tracks.find((candidate) => candidate.selected);
        return selected?.params === best.params && next?.segments.length ? next : undefined;
      }, deadline);
    }
  }
  const selected = state?.tracks.find((candidate) => candidate.selected);
  if (!state || !selected || state.segments.length === 0) return undefined;
  return {
    video_id: videoId,
    language: selected.language,
    kind: selected.kind,
    segments: state.segments,
  };
}

async function reply(): Promise<void> {
  const transcript = await currentTranscript().catch(() => undefined);
  const detail = JSON.stringify(transcript ?? null);
  window.dispatchEvent(new CustomEvent(TRANSCRIPT_EVENT, { detail }));
}

// Runs in the page's own world: YouTube's app and its data are invisible to
// the isolated content script that serialises the page.
export default defineContentScript({
  matches: ["*://youtube.com/*", "*://*.youtube.com/*"],
  world: "MAIN",
  main() {
    window.addEventListener(TRANSCRIPT_REQUEST_EVENT, (event) => {
      event.preventDefault();
      void reply();
    });
  },
});
