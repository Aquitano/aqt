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
  "raw_input?": "number",
  native_thread_id: "string",
  has_reply_links: "boolean",
  incomplete: "boolean",
  conflict_key: "string",
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
const mailConflict = type({
  _tag: "'MailThreadConflict'",
  source: "string",
  conflict_key: "string",
  choices: "string[]",
  unanchored_path: "string",
});
export class MailConflictError extends Error {
  readonly conflict: typeof mailConflict.infer;
  constructor(conflict: typeof mailConflict.infer) {
    super("This conversation contains conflicting provider threads.");
    this.conflict = conflict;
  }
}

async function send(path: string, init?: RequestInit) {
  const r = await fetch(path, init);
  const body: unknown = await r.json().catch(() => undefined);
  if (r.ok) return body;
  const conflict = mailConflict(body);
  if (!(conflict instanceof type.errors)) throw new MailConflictError(conflict);
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
  match?: "any" | "all" | "phrase";
  fuzzy?: number;
  to?: string;
  person?: string;
}

export function search({
  q,
  mailbox_id,
  subject,
  has_attachment,
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
  if (mailbox_id) p.set("mailbox_id", String(mailbox_id));
  if (subject) p.set("subject", subject);
  if (has_attachment !== undefined) p.set("has_attachment", String(has_attachment));
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  if (person) p.set("person", person);
  if (since) p.set("since", since);
  if (until) p.set("until", until);
  p.set("kind", "message");
  return api(`/v1/search?${p}`, messageResults).then((result) => result.messages);
}

const messageResults = type({ messages: message.array() });

export function getMessage(ref: string) {
  return api(`/v1/messages/${ref}`, message);
}

export interface ThreadPosition {
  before?: string;
  after?: string;
  around?: string;
  latest?: boolean;
  current?: boolean;
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

export function browseThreads(
  opts: Omit<SearchParams, "q" | "match" | "fuzzy" | "offset"> & {
    order: "asc" | "desc";
    offset: number;
  },
) {
  const p = new URLSearchParams({
    order: opts.order,
    offset: String(opts.offset),
    limit: String(BROWSE_PAGE),
  });
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

export function getMailConflict(source: string, key: string, before?: string) {
  const params = new URLSearchParams({ source, limit: String(CONTEXT_PAGE) });
  if (before) params.set("before", before);
  return api(`/v1/mail-conflicts/${encodeURIComponent(key)}?${params}`, thread);
}

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
