import { type } from "arktype";

export const TRANSCRIPT_REQUEST_EVENT = "aqt-tracker:transcript-request";
export const TRANSCRIPT_EVENT = "aqt-tracker:transcript";

export const Transcript = type({
  video_id: "string",
  language: "string",
  kind: "'manual' | 'asr'",
  segments: type({ start: "number", text: "string" }).array(),
});
export type Transcript = typeof Transcript.infer;

export const TranscriptReply = type("string.json.parse").to(Transcript);

export function withTranscript(html: string, transcript: Transcript): string {
  const end = html.lastIndexOf("</body>");
  if (end < 0) return html;
  const json = JSON.stringify(transcript).replaceAll("<", String.raw`<`);
  const script = `<script type="application/json" id="tracker-transcript">${json}</script>`;
  return html.slice(0, end) + script + html.slice(end);
}
