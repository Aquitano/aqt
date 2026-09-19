// Thin typed client for the /v1 API proxied by `bank ui`.
import { type, type Type } from "arktype";

const attachment = type({
  filename: "string",
  "mime_type?": "string",
  "size_bytes?": "number",
  sha256: "string",
  "text_status?": "string",
  "text_chars?": "number",
});
export type Attachment = typeof attachment.infer;

const message = type({
  id: "number",
  source: "string",
  "thread_id?": "string | null",
  "sender?": "string",
  "recipients?": "string[] | null",
  "subject?": "string",
  "body?": "string",
  "snippet?": "string",
  "attachment_snippet?": "string",
  sent_at: "string",
  "attachments?": attachment.array().or("null"),
});
export type Message = typeof message.infer;

const thread = type({ messages: message.array(), has_before: "boolean", has_after: "boolean" });
export type Thread = typeof thread.infer;

const contact = type({
  name: "string",
  "note?": "string",
  "aliases?": type({ "source?": "string", value: "string" }).array().or("null"),
});
export type Contact = typeof contact.infer;

const sourceStat = type({
  source: "string",
  messages: "number",
  earliest: "string",
  latest: "string",
  last_ingest: "string",
});
export type SourceStat = typeof sourceStat.infer;

const contactSuggestion = type({
  identity: "string",
  messages: "number",
  sources: "string[]",
  samples: "string[]",
});
export type ContactSuggestion = typeof contactSuggestion.infer;

const threadGroup = type({
  source: "string",
  thread_id: "string",
  n: "number",
  last_at: "string",
  last_id: "number",
  sender: "string",
  subject: "string",
  preview: "string",
  members: "string",
});
export type ThreadGroup = typeof threadGroup.infer;

// Failed /v1 requests answer with `{"error": "..."}` in place of the payload.
const errorBody = type({ error: "string" });

async function send(path: string, init?: RequestInit) {
  const r = await fetch(path, init);
  const body: unknown = await r.json().catch(() => undefined);
  if (r.ok) return body;
  const failure = errorBody(body);
  throw new Error(failure instanceof type.errors ? r.statusText : failure.error || r.statusText);
}

async function api<T extends Type>(
  path: string,
  schema: T,
  init?: RequestInit,
): Promise<T["infer"]> {
  const parsed = schema(await send(path, init));
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected response from ${path}: ${parsed.summary}`);
  }
  return parsed;
}

export interface SearchParams {
  q: string;
  source?: string;
  from?: string;
  since?: string;
  until?: string;
  offset?: number;
  match?: "any" | "all" | "phrase";
  fuzzy?: number;
  to?: string;
  person?: string;
}

export function search({
  q,
  source,
  from,
  since,
  until,
  offset = 0,
  match = "any",
  fuzzy = 1,
  to,
  person,
}: SearchParams) {
  const p = new URLSearchParams({
    q,
    limit: "50",
    offset: String(offset),
    match,
    fuzzy: String(fuzzy),
  });
  if (source) p.set("source", source);
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  if (person) p.set("person", person);
  if (since) p.set("since", since);
  if (until) p.set("until", until);
  return api(`/v1/search?${p}`, message.array());
}

export function getMessage(id: number) {
  return api(`/v1/messages/${id}`, message);
}

export interface ThreadPosition {
  before?: number;
  after?: number;
  around?: number;
  latest?: boolean;
}
export function getThread(source: string, threadId: string, position: ThreadPosition) {
  const p = new URLSearchParams({ source, limit: "100" });
  for (const [key, value] of Object.entries(position)) {
    if (value !== undefined) p.set(key, String(value));
  }
  return api(`/v1/threads/${encodeURIComponent(threadId)}?${p}`, thread);
}

export function getStats() {
  return api("/v1/stats", sourceStat.array());
}

export function getContacts() {
  return api("/v1/contacts", contact.array());
}

export function getContactMessages(name: string, before?: number) {
  return api(
    `/v1/contacts/${encodeURIComponent(name)}/messages?limit=100${before ? `&before=${before}` : ""}`,
    message.array(),
  );
}

export function suggestContacts(limit = 40) {
  return api(`/v1/contacts/suggest?limit=${limit}`, contactSuggestion.array());
}

export async function createContactWithAlias(name: string, alias: string) {
  await send("/v1/contacts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  await send(`/v1/contacts/${encodeURIComponent(name)}/aliases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "", value: alias }),
  });
}

export function browseThreads(opts: { source?: string; order: "asc" | "desc"; offset: number }) {
  const p = new URLSearchParams({
    order: opts.order,
    offset: String(opts.offset),
    limit: String(BROWSE_PAGE),
  });
  if (opts.source) p.set("source", opts.source);
  return api(`/v1/threads?${p}`, threadGroup.array());
}

export const BROWSE_PAGE = 50;
export const SEARCH_PAGE = 50;
export const CONTEXT_PAGE = 100;
