// Thin typed client for the /v1 API proxied by `bank ui`.
import { type, type Type } from "arktype";

const attachment = type({
  filename: "string",
  "mime_type?": "string",
  "size_bytes?": "number",
  blake3: "string",
  "text_status?": "string",
  "text_chars?": "number",
});
export type Attachment = typeof attachment.infer;

const mailbox = type({
  id: "number",
  source: "string",
  kind: "'export' | 'imap'",
  path: "string",
  n: "number",
});
export type Mailbox = typeof mailbox.infer;

const mailProvenance = type({
  message_id: "string",
  in_reply_to: "string[]",
  references: "string[]",
  native: "boolean",
});

// A message ref, the only way a message is named outside the server.
export const messageRef = /^msg:[0-9a-f]{16}$/;

export const message = type({
  ref: "string",
  source: "string",
  "raw_input?": "number",
  "raw_locator?": "string",
  "message_id?": "string",
  "mail?": mailProvenance,
  "external_id?": "string",
  "parent_external_id?": "string",
  "branch_id?": "string",
  "alternative_index?": "number",
  "thread_id?": "string | null",
  "sender?": "string",
  "recipients?": "string[] | null",
  "subject?": "string",
  "body?": "string",
  "snippet?": "string",
  "attachment_snippet?": "string",
  // Absent when the source did not say when the message was sent.
  "sent_at?": "string",
  "attachments?": attachment.array().or("null"),
  "mailboxes?": mailbox.array().or("null"),
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
  undated: "number",
  "earliest?": "string",
  "latest?": "string",
  last_ingest: "string",
  last_sync: "string | null",
  "note?": "string",
  stale: "boolean",
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
  "last_at?": "string",
  last_ref: "string",
  sender: "string",
  subject: "string",
  preview: "string",
  members: "string",
});
export type ThreadGroup = typeof threadGroup.infer;

// Every failed /v1 request answers with a `_tag` naming the failure and a
// `message`; some tags carry fields of their own.
const errorBody = type({ _tag: "string", message: "string" });
export class RequestError extends Error {
  readonly status: number;
  readonly tag: string;
  constructor(status: number, tag: string, description: string) {
    super(description);
    this.status = status;
    this.tag = tag;
  }
}
async function send(path: string, init?: RequestInit) {
  const r = await fetch(path, init);
  const body: unknown = await r.json().catch(() => undefined);
  if (r.ok) return body;
  const failure = errorBody(body);
  if (failure instanceof type.errors) throw new RequestError(r.status, "", r.statusText);
  throw new RequestError(r.status, failure._tag, failure.message || r.statusText);
}

export async function api<T extends Type>(
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
  mailbox_id?: number;
  subject?: string;
  has_attachment?: boolean;
  source?: string;
  from?: string;
  since?: string;
  until?: string;
  offset?: number;
  match?: "all" | "any";
  to?: string;
  person?: string;
}

const filePlace = type({
  kind: "'message' | 'library_file' | 'disk'",
  "ref?": "string",
  name: "string",
  "at?": "string",
  "source?": "string",
  "thread_id?": "string",
  "entry_id?": "number",
  "volume?": "string",
  "path?": "string",
  "missing?": "boolean",
  "previous?": "boolean",
});
export type FilePlace = typeof filePlace.infer;

const searchHit = type({
  kind: "'message' | 'file' | 'item' | 'activity' | 'collection' | 'page'",
  "ref?": "string",
  "blake3?": "string",
  "type?": "string",
  title: "string",
  "snippet?": "string",
  "at?": "string",
  "day_only?": "boolean",
  "source?": "string",
  "thread_id?": "string",
  "places?": filePlace.array(),
  "place_count?": "number",
  score: "number",
  matched: "string[]",
});
export type SearchHit = typeof searchHit.infer;

const searchResult = type({
  hits: searchHit.array(),
  counts: type({ kind: "string", matches: "number" }).array(),
  coverage: "string[]",
});
export type SearchResult = typeof searchResult.infer;

// One ranked list of every kind of record, a page at a time.
export function find(params: SearchParams, offset = 0) {
  const p = new URLSearchParams({ limit: String(SEARCH_PAGE), offset: String(offset) });
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && key !== "offset") p.set(key, String(value));
  return api(`/v1/search?${p}`, searchResult);
}

export function getMessage(ref: string) {
  return api(`/v1/messages/${ref}`, message);
}

export interface ThreadPosition {
  before?: string;
  after?: string;
  around?: string;
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

export function createContact(name: string) {
  return api("/v1/contacts", contact, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export function addContactAlias(name: string, value: string, source = "") {
  return send(`/v1/contacts/${encodeURIComponent(name)}/aliases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, value }),
  });
}

export function removeContactAlias(name: string, value: string, source = "") {
  return send(
    `/v1/contacts/${encodeURIComponent(name)}/aliases?${new URLSearchParams({ source, value })}`,
    {
      method: "DELETE",
    },
  );
}

export function getContactMessages(name: string, before?: string) {
  return api(
    `/v1/contacts/${encodeURIComponent(name)}/messages?limit=100${before ? `&before=${before}` : ""}`,
    message.array(),
  );
}

export function suggestContacts(limit = 40) {
  return api(`/v1/contacts/suggest?limit=${limit}`, contactSuggestion.array());
}

export function getMailboxes(source: string) {
  return api(`/v1/mailboxes?${new URLSearchParams({ source })}`, mailbox.array());
}

// A page of conversations; after is the last_ref of the previous page's last row.
export function browseThreads(
  opts: Omit<SearchParams, "q" | "match" | "offset"> & {
    order: "asc" | "desc";
    after?: string;
  },
) {
  const p = new URLSearchParams({ order: opts.order, limit: String(BROWSE_PAGE) });
  if (opts.after) p.set("after", opts.after);
  if (opts.source) p.set("source", opts.source);
  if (opts.mailbox_id) p.set("mailbox_id", String(opts.mailbox_id));
  if (opts.has_attachment !== undefined) p.set("has_attachment", String(opts.has_attachment));
  for (const key of ["subject", "from", "to", "person", "since", "until"] as const) {
    if (opts[key]) p.set(key, opts[key]);
  }
  return api(`/v1/threads?${p}`, threadGroup.array());
}

export const BROWSE_PAGE = 50;
export const SEARCH_PAGE = 50;
export const CONTEXT_PAGE = 100;

export const libraryFile = type({
  blake3: "string",
  filename: "string",
  mime_type: "string",
  size_bytes: "number",
  messages: "number",
  "last_at?": "string",
  "snippet?": "string",
});
export type LibraryFile = typeof libraryFile.infer;
export function getLibrary(
  filters: { q: string; text: string; type: string; person: string; since: string; until: string },
  offset: number,
) {
  return api(
    `/v1/attachment-library?${new URLSearchParams({ ...filters, offset: String(offset) })}`,
    libraryFile.array(),
  );
}
export function getFileMessages(sum: string, offset: number) {
  return api(`/v1/attachments/${sum}/messages?offset=${offset}`, message.array());
}
const blobText = type({ text: "string", status: "string" });
export function getFileText(sum: string) {
  return api(`/v1/attachments/${sum}/text`, blobText);
}
export const rawInput = type({
  id: "number",
  kind: "string",
  name: "string",
  size_bytes: "number",
  received_at: "string",
  finished_at: "string | null",
  status: "'running' | 'complete' | 'gaps' | 'failed'",
  error: "string",
  report: type({
    inserted: "number",
    duplicates: "number",
    retired: "number",
    attachments: "number",
    library: type({
      items: "number",
      activity: "number",
      collections: "number",
      files: "number",
      pages: "number",
      duplicates: "number",
    }),
    issues: "Record<string, number> | null",
    details: type({ kind: "string", detail: "string" }).array().or("null"),
  }),
});
export type RawInput = typeof rawInput.infer;
export function getRawInputs(before = 0) {
  return api(`/v1/raw-inputs?before=${before}`, rawInput.array());
}

export function getMessageParent(ref: string) {
  return api(`/v1/messages/${ref}/parent`, message);
}

export function getMessageBranch(ref: string) {
  return api(
    `/v1/messages/${ref}/branch`,
    type({ messages: message.array(), incomplete: "boolean" }),
  );
}
