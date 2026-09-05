// Display helpers shared across views: source badges, dates, query highlighting.

const SOURCE_HUES: Record<string, number> = {
  whatsapp: 130,
  gmail: 10,
  proton: 270,
  discord: 235,
  linkedin: 205,
  chatgpt: 170,
  claude: 25,
  "claude-code": 40,
}

export function sourceHue(src: string): number {
  return (
    SOURCE_HUES[src] ??
    (Array.from(src).reduce((a, c) => a + c.charCodeAt(0), 0) * 37) % 360
  )
}

export function SourceBadge({ source }: { source: string }) {
  const h = sourceHue(source)
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10px] font-semibold tracking-wide"
      style={{
        color: `hsl(${h} 60% 65%)`,
        borderColor: `hsl(${h} 40% 35%)`,
        background: `hsl(${h} 50% 60% / 0.08)`,
      }}
    >
      {source}
    </span>
  )
}

// WhatsApp exports record the owner as bare "Thomas"; mail sources use the
// full name or address; AI chat transcripts record the owner as "user"/"human".
const ME = /thomas breindl|breindlthomas|^thomas$|^(user|human|me)$/i
export const isMe = (sender?: string | null) => ME.test((sender ?? "").trim())

// Sources whose message bodies are markdown worth rendering as such
const AI_SOURCES = new Set(["chatgpt", "claude", "claude-code", "codex", "opencode"])
export const isMarkdownSource = (source: string) => AI_SOURCES.has(source)

const URL_RE = /https?:\/\/[^\s<>"'()[\]]+/g

function shortUrl(url: string) {
  const bare = url.replace(/^https?:\/\/(www\.)?/, "")
  return bare.length > 60 ? bare.slice(0, 57) + "…" : bare
}

// Plain text with URLs turned into links, displayed shortened so tracking
// URLs stop dominating the layout.
export function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE)
  const urls = text.match(URL_RE) ?? []
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {urls[i] && (
            <a
              href={urls[i]}
              target="_blank"
              rel="noreferrer noopener"
              className="break-all text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
            >
              {shortUrl(urls[i])}
            </a>
          )}
        </span>
      ))}
    </>
  )
}

export const fmtDay = (d: string) =>
  new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })

export const fmtTime = (d: string) =>
  new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })

// Compact list-row date: time today, day+month this year, month+year otherwise.
export function fmtDate(d: string) {
  const t = new Date(d)
  const now = new Date()
  if (t.toDateString() === now.toDateString()) return fmtTime(d)
  if (t.getFullYear() === now.getFullYear())
    return t.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
  return t.toLocaleDateString("en-GB", { month: "short", year: "numeric" })
}

// Renders text with query terms wrapped in <mark>. Safe: builds React nodes,
// never HTML strings.
export function Highlight({ text, query }: { text: string; query?: string }) {
  const words = (query ?? "").split(/\s+/).filter((w) => w.length > 1)
  if (!words.length) return <>{text}</>
  const re = new RegExp(
    `(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  )
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-transparent font-semibold text-amber-500 dark:text-amber-300">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  )
}
