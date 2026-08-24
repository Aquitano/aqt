// Thin typed client for the /v1 API proxied by `bank ui`.

export interface Attachment {
  filename: string
  mime_type?: string
  size_bytes?: number
  sha256: string
}

export interface Message {
  id: number
  source: string
  thread_id?: string | null
  sender?: string
  recipients?: string[]
  subject?: string
  body?: string
  snippet?: string
  attachment_snippet?: string
  sent_at: string
  attachments?: Attachment[]
}

export interface Thread {
  messages: Message[]
  truncated?: boolean
}

export interface Contact {
  name: string
  note?: string
  aliases?: { source?: string; value: string }[]
}

export interface SourceStat {
  source: string
  messages: number
  earliest: string
  latest: string
  last_ingest: string
}

// One row in the thread-grouped browse list. Unthreaded messages appear as
// singleton groups (gid = "msg:<id>").
export interface ThreadGroup {
  source: string
  gid: string
  n: number
  last_at: string
  last_id: number
  sender: string
  subject: string
  preview: string
  // distinct non-me senders, for titling unnamed group chats by participants
  members: string | null
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((data as { error?: string }).error || r.statusText)
  return data as T
}

export interface SearchParams {
  q: string
  source?: string
  from?: string
  since?: string
  until?: string
  offset?: number
}

export function search({ q, source, from, since, until, offset = 0 }: SearchParams) {
  const p = new URLSearchParams({ q, limit: "50", offset: String(offset) })
  if (source) p.set("source", source)
  if (from) p.set("from", from)
  if (since) p.set("since", since)
  if (until) p.set("until", until)
  return api<Message[]>(`/v1/search?${p}`)
}

export function getMessage(id: number) {
  return api<Message>(`/v1/messages/${id}`)
}

export function getThread(source: string, threadId: string) {
  return api<Thread>(
    `/v1/threads/${encodeURIComponent(threadId)}?source=${encodeURIComponent(source)}&limit=2000`,
  )
}

export function getStats() {
  return api<SourceStat[]>("/v1/stats")
}

export function getContacts() {
  return api<Contact[]>("/v1/contacts")
}

export function getContactMessages(name: string) {
  return api<Message[]>(`/v1/contacts/${encodeURIComponent(name)}/messages?limit=500`)
}

function query(sql: string, limit: number) {
  return api<{ columns: string[]; rows: unknown[][] }>("/v1/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, limit }),
  })
}

const PAGE = 50

export async function browseThreads(opts: {
  source?: string
  order: "asc" | "desc"
  offset: number
}): Promise<ThreadGroup[]> {
  const where = opts.source ? `where source = '${opts.source.replace(/'/g, "''")}'` : ""
  const order = opts.order === "asc" ? "asc" : "desc"
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
    limit ${PAGE} offset ${opts.offset}`
  const res = await query(sql, PAGE)
  return res.rows.map(
    (r) => Object.fromEntries(res.columns.map((c, i) => [c, r[i]])) as unknown as ThreadGroup,
  )
}

export const BROWSE_PAGE = PAGE
export const SEARCH_PAGE = 50
