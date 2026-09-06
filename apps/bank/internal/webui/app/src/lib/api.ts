// Thin typed client for the /v1 API proxied by `bank ui`.
import { type, type Type } from "arktype";

const attachment = type({
  filename: "string",
  "mime_type?": "string",
  "size_bytes?": "number",
  sha256: "string",
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

const thread = type({ messages: message.array(), "truncated?": "boolean" });
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

const queryResult = type({ columns: "string[]", rows: "unknown[][]" });

// One row in the thread-grouped browse list. Unthreaded messages appear as
// singleton groups (gid = "msg:<id>").
export interface ThreadGroup {
  source: string;
  gid: string;
  n: number;
  last_at: string;
  last_id: number;
  sender: string;
  subject: string;
  preview: string;
  // distinct non-me senders, for titling unnamed group chats by participants
  members: string | null;
}

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
}

export function search({ q, source, from, since, until, offset = 0 }: SearchParams) {
  const p = new URLSearchParams({ q, limit: "50", offset: String(offset) });
  if (source) p.set("source", source);
  if (from) p.set("from", from);
  if (since) p.set("since", since);
  if (until) p.set("until", until);
  return api(`/v1/search?${p}`, message.array());
}

export function getMessage(id: number) {
  return api(`/v1/messages/${id}`, message);
}

export function getThread(source: string, threadId: string) {
  return api(
    `/v1/threads/${encodeURIComponent(threadId)}?source=${encodeURIComponent(source)}&limit=2000`,
    thread,
  );
}

export function getStats() {
  return api("/v1/stats", sourceStat.array());
}

export function getContacts() {
  return api("/v1/contacts", contact.array());
}

export function getContactMessages(name: string) {
  return api(`/v1/contacts/${encodeURIComponent(name)}/messages?limit=500`, message.array());
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

function query(sql: string, limit: number) {
  return api("/v1/query", queryResult, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, limit }),
  });
}

// /v1/query answers with positional rows, so each column is read back by name
// and coerced into the ThreadGroup contract the browse list works with.
function toThreadGroup(columns: string[], row: unknown[]): ThreadGroup {
  const cell = (column: string) => row[columns.indexOf(column)];
  const members = cell("members");
  return {
    source: String(cell("source")),
    gid: String(cell("gid")),
    n: Number(cell("n")),
    last_at: String(cell("last_at")),
    last_id: Number(cell("last_id")),
    sender: String(cell("sender")),
    subject: String(cell("subject")),
    preview: String(cell("preview")),
    members: typeof members === "string" ? members : null,
  };
}

const PAGE = 50;

export async function browseThreads(opts: {
  source?: string;
  order: "asc" | "desc";
  offset: number;
}): Promise<ThreadGroup[]> {
  const where = opts.source ? `where source = '${opts.source.replace(/'/g, "''")}'` : "";
  const order = opts.order === "asc" ? "asc" : "desc";
  const sql = `
    select source,
           coalesce(nullif(thread_id, ''), 'msg:' || id::text) as gid,
           count(*) as n,
           max(sent_at) as last_at,
           (array_agg(id order by sent_at desc))[1] as last_id,
           (array_agg(coalesce(sender, '') order by sent_at desc))[1] as sender,
           coalesce((array_agg(nullif(subject, '') order by sent_at desc)
                     filter (where nullif(subject, '') is not null))[1], '') as subject,
           (array_agg(left(coalesce(body, ''), 240) order by sent_at desc))[1] as preview,
           left(string_agg(distinct case
             when sender is not null and sender !~* '^thomas( breindl)?$' then sender
           end, ', '), 200) as members
    from messages ${where}
    group by source, gid
    order by last_at ${order}
    limit ${PAGE} offset ${opts.offset}`;
  const res = await query(sql, PAGE);
  return res.rows.map((row) => toThreadGroup(res.columns, row));
}

export const BROWSE_PAGE = PAGE;
export const SEARCH_PAGE = 50;
