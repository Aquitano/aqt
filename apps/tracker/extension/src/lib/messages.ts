import { type } from "arktype";

export const UrlChangedMessage = type({
  type: "'url_changed'",
  url: "string",
  navigation_type: "'spa' | 'back_forward'",
});
export type UrlChangedMessage = typeof UrlChangedMessage.infer;

export const PopupMessage = type({ type: "'status'" }).or({ type: "'capture_now'" });
export type PopupMessage = typeof PopupMessage.infer;

export const BackgroundMessage = UrlChangedMessage.or(PopupMessage);
export type BackgroundMessage = typeof BackgroundMessage.infer;

export const SerializeRequest = type({ type: "'serialize'" });
export type SerializeRequest = typeof SerializeRequest.infer;

export const SerializeReply = type({
  html: "string",
  title: "string",
  url: "string",
  dirty: "boolean",
});
export type SerializeReply = typeof SerializeReply.infer;

export const StatusReply = type({
  connected: "boolean",
  pendingEvents: "number",
  pendingCaptures: "number",
  "lastSyncAt?": "string",
  "lastError?": "string",
  dropped: "number",
  diagnostics: "string[]",
});
export type StatusReply = typeof StatusReply.infer;

export const CaptureNowReply = type({ ok: "true" }).or({ ok: "false", error: "string" });
export type CaptureNowReply = typeof CaptureNowReply.infer;
