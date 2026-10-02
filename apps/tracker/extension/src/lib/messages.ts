import { type } from "arktype";

import { ForgetCounts } from "./events.ts";

export const UrlChangedMessage = type({
  type: "'url_changed'",
  url: "string",
  navigation_type: "'spa' | 'back_forward'",
});
export type UrlChangedMessage = typeof UrlChangedMessage.infer;

export const ForgetScope = type("'page' | 'host'");
export type ForgetScope = typeof ForgetScope.infer;

export const ForgetMessage = type({ type: "'forget'", scope: ForgetScope });
export type ForgetMessage = typeof ForgetMessage.infer;

export const PopupMessage = type({ type: "'status'" })
  .or({ type: "'capture_now'" })
  .or({ type: "'pause'" })
  .or({ type: "'resume'" })
  .or({ type: "'make_private'" })
  .or(ForgetMessage);
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
  auth: "'off' | 'in' | 'out'",
  pendingEvents: "number",
  pendingCaptures: "number",
  "lastSyncAt?": "string",
  "lastError?": "string",
  dropped: "number",
  diagnostics: "string[]",
  "pausedUntil?": "number",
});
export type StatusReply = typeof StatusReply.infer;

export const ActionReply = type({ ok: "true" }).or({ ok: "false", error: "string" });
export type ActionReply = typeof ActionReply.infer;

export const ForgetReply = type({ ok: "true", forgotten: ForgetCounts }).or({
  ok: "false",
  error: "string",
});
export type ForgetReply = typeof ForgetReply.infer;
