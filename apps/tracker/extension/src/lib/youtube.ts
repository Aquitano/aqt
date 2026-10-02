import { type } from "arktype";

import type { Transcript } from "./transcript.ts";

type Track = Pick<Transcript, "language" | "kind"> & { videoId: string };

export const TranscriptPanel = type({
  content: {
    continuationItemRenderer: {
      continuationEndpoint: { getTranscriptEndpoint: { params: "string" } },
    },
  },
});

const Segment = type({
  "transcriptSegmentRenderer?": {
    startMs: "string.numeric.parse",
    snippet: { "runs?": type({ text: "string" }).array() },
  },
});

const LanguageItem = type({
  selected: "boolean",
  continuation: { reloadContinuationData: { continuation: "string" } },
});

export const LoadedTranscript = type({
  body: { transcriptSegmentListRenderer: { "initialSegments?": Segment.array() } },
  footer: {
    transcriptFooterRenderer: {
      languageMenu: { sortFilterSubMenuRenderer: { subMenuItems: LanguageItem.array() } },
    },
  },
}).pipe(({ body, footer }) => ({
  tracks: footer.transcriptFooterRenderer.languageMenu.sortFilterSubMenuRenderer.subMenuItems.map(
    ({ selected, continuation }) => {
      const params = continuation.reloadContinuationData.continuation;
      return { params, selected, ...track(params) };
    },
  ),
  segments: (body.transcriptSegmentListRenderer.initialSegments ?? []).flatMap(
    ({ transcriptSegmentRenderer: segment }) =>
      segment
        ? [
            {
              start: segment.startMs / 1000,
              text: (segment.snippet.runs ?? []).map((run) => run.text).join(""),
            },
          ]
        : [],
  ),
}));
export type LoadedTranscript = typeof LoadedTranscript.infer;

// Transcript params are base64 protobuf: the video id in field 1 and the track
// in field 2, itself base64 protobuf of its kind (1) and language (2).
export function track(params: string): Track {
  const outer = protobufStrings(params);
  const inner = protobufStrings(outer.get(2) ?? "");
  return {
    videoId: outer.get(1) ?? "",
    language: inner.get(2) ?? "",
    kind: inner.get(1) === "asr" ? "asr" : "manual",
  };
}

export function preferredTrack<T extends Track>(
  tracks: readonly T[],
  pageLanguage: string,
): T | undefined {
  const manual = (language: string) =>
    tracks.find(
      (candidate) => candidate.kind === "manual" && primary(candidate.language) === language,
    );
  return (
    manual(primary(pageLanguage)) ??
    manual("en") ??
    tracks.find((candidate) => candidate.kind === "asr")
  );
}

function primary(languageTag: string): string {
  return languageTag.toLowerCase().split("-")[0] ?? "";
}

function protobufStrings(encoded: string): Map<number, string> {
  const strings = new Map<number, string>();
  const bytes = base64Bytes(encoded);
  let at = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; at < bytes.length; shift += 7) {
      const byte = bytes[at++] ?? 0;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) break;
    }
    return value;
  };
  while (at < bytes.length) {
    const key = varint();
    const wireType = key % 8;
    if (wireType === 0) {
      varint();
    } else if (wireType === 2) {
      const length = varint();
      strings.set(Math.floor(key / 8), new TextDecoder().decode(bytes.subarray(at, at + length)));
      at += length;
    } else {
      break;
    }
  }
  return strings;
}

function base64Bytes(encoded: string): Uint8Array {
  try {
    return Uint8Array.from(atob(decodeURIComponent(encoded)), (char) => char.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}
