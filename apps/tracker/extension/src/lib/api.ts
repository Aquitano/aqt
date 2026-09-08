import { type Type, type } from "arktype";

import { errorMessage } from "./errors.ts";
import type { CapturePayload, TrackerEvent } from "./events.ts";
import { RulesResponse, type Rule } from "./rules.ts";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; status?: number };

// 408 and 429 are the only client errors a retry can fix.
export function isPermanentFailure(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

const HealthReply = type({ ok: "boolean", db: "boolean" });
const BatchReply = type({ accepted: "number", dropped: "number" });
const CaptureReply = type({ capture_id: "string", raw_hash: "string", deduplicated: "boolean" });

async function call<T extends Type>(
  url: string,
  init: RequestInit | undefined,
  schema: T,
): Promise<Result<T["infer"]>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    return { ok: false, error: `${url}: ${errorMessage(error)}` };
  }
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).trim();
    const error = `${url}: HTTP ${response.status}${text ? ` ${text}` : ""}`;
    return { ok: false, error, status: response.status };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, error: `${url}: ${errorMessage(error)}` };
  }
  const decoded = schema(body);
  if (decoded instanceof type.errors) return { ok: false, error: `${url}: ${decoded.summary}` };
  return { ok: true, value: decoded };
}

export function fetchRules(serverUrl: string): Promise<Result<Rule[]>> {
  return call(`${serverUrl}/v1/capture-rules`, undefined, RulesResponse);
}

export function checkHealth(serverUrl: string) {
  return call(`${serverUrl}/healthz`, undefined, HealthReply);
}

export function postEvents(serverUrl: string, deviceId: string, events: readonly TrackerEvent[]) {
  return call(
    `${serverUrl}/v1/events/batch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, events }),
    },
    BatchReply,
  );
}

export function postCapture(serverUrl: string, capture: CapturePayload) {
  const form = new FormData();
  form.append("meta", JSON.stringify(capture.meta));
  form.append("html", new Blob([capture.html], { type: "text/html" }), "page.html");
  return call(`${serverUrl}/v1/captures`, { method: "POST", body: form }, CaptureReply);
}
