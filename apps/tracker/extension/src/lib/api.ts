import { type Type, type } from "arktype";

import { bearer, refresh } from "./auth.ts";
import { errorMessage } from "./errors.ts";
import type { CapturePayload, TrackerEvent } from "./events.ts";
import type { Result } from "./result.ts";
import { RulesResponse, type Rule } from "./rules.ts";

export type { Result } from "./result.ts";

const HealthReply = type({ ok: "boolean", db: "boolean" });
const BatchReply = type({ accepted: "number", dropped: "number" });
const CaptureReply = type({ capture_id: "string", raw_hash: "string", deduplicated: "boolean" });
const REQUEST_TIMEOUT_MS = 15_000;

// healthz is the one route the server leaves open, so it answers even when
// this extension is signed out. That is what tells "server down" apart from
// "signed out" in the popup.
type Authorize = "required" | "none";

function authorized(init: RequestInit | undefined, token: string | undefined): RequestInit {
  if (!token) return init ?? {};
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

async function call<T extends Type>(
  url: string,
  init: RequestInit | undefined,
  schema: T,
  authorize: Authorize = "required",
): Promise<Result<T["infer"]>> {
  let token: string | undefined;
  if (authorize === "required") {
    const got = await bearer();
    if (!got.ok) return got;
    token = got.value;
  }
  let response: Response;
  try {
    response = await fetch(url, {
      ...authorized(init, token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 && authorize === "required") {
      const renewed = await refresh();
      if (!renewed.ok) return renewed;
      if (renewed.value === token) {
        return { ok: false, error: `${url}: HTTP 401`, status: response.status };
      }
      response = await fetch(url, {
        ...authorized(init, renewed.value),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    }
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
  return call(`${serverUrl}/healthz`, undefined, HealthReply, "none");
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
