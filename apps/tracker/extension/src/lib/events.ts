import { type } from "arktype";

export const NavigationType = type("'load' | 'spa' | 'reload' | 'back_forward'");
export type NavigationType = typeof NavigationType.infer;

export const EndReason = type(
  "'tab_switch' | 'window_blur' | 'idle' | 'navigation' | 'tab_closed' | 'unknown'",
);
export type EndReason = typeof EndReason.infer;

export const PageViewEvent = type({
  type: "'page_view'",
  id: "string",
  url: "string",
  "title?": "string",
  started_at: "string",
  navigation_type: NavigationType,
  "referrer?": "string",
  tab_session_id: "string",
  private: "boolean",
});
export type PageViewEvent = typeof PageViewEvent.infer;

export const SpanStartEvent = type({
  type: "'span_start'",
  id: "string",
  page_view_id: "string",
  started_at: "string",
});

export const SpanHeartbeatEvent = type({ type: "'span_heartbeat'", id: "string", at: "string" });

export const SpanEndEvent = type({
  type: "'span_end'",
  id: "string",
  ended_at: "string",
  reason: EndReason,
});

export const TrackerEvent = PageViewEvent.or(SpanStartEvent)
  .or(SpanHeartbeatEvent)
  .or(SpanEndEvent);
export type TrackerEvent = typeof TrackerEvent.infer;

export const CaptureReason = type("'initial' | 'recapture' | 'manual'");
export type CaptureReason = typeof CaptureReason.infer;

export const CaptureMeta = type({
  capture_id: "string",
  page_view_id: "string",
  device_id: "string",
  captured_at: "string",
  url: "string",
  "title?": "string",
  extractor: "string",
  reason: CaptureReason,
  raw_char_count: "number",
});
export type CaptureMeta = typeof CaptureMeta.infer;

export const CapturePayload = type({ meta: CaptureMeta, html: "string" });
export type CapturePayload = typeof CapturePayload.infer;
