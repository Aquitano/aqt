// Display helpers shared across views: source badges, dates, query highlighting.

import type { ReactNode } from "react";

const SOURCE_HUES = new Map([
  ["whatsapp", 130],
  ["gmail", 10],
  ["proton", 270],
  ["discord", 235],
  ["linkedin", 205],
  ["chatgpt", 170],
  ["claude", 25],
  ["claude-code", 40],
]);

export function sourceHue(src: string): number {
  return (
    SOURCE_HUES.get(src) ?? (Array.from(src).reduce((a, c) => a + c.charCodeAt(0), 0) * 37) % 360
  );
}

export function SourceBadge({ source }: { source: string }) {
  const h = sourceHue(source);
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
  );
}

// WhatsApp exports record the owner as bare "Thomas"; mail sources use the
// full name or address; AI chat transcripts record the owner as "user"/"human".
const ME = /thomas breindl|breindlthomas|^thomas$|^(user|human|me)$/i;
export const isMe = (sender?: string | null) => ME.test((sender ?? "").trim());

// Sources whose message bodies are markdown worth rendering as such
const AI_SOURCES = new Set(["chatgpt", "claude", "claude-code", "codex", "opencode"]);
export const isMarkdownSource = (source: string) => AI_SOURCES.has(source);

// Raw WhatsApp JIDs make useless titles; unnamed group chats are titled by
// their participants instead, the way messengers do it.
const JID = /@(g\.us|s\.whatsapp\.net)$/;

export function threadTitle(threadId: string, subject: string, members: string) {
  if (subject) return subject;
  if (JID.test(threadId) && members) return members;
  return threadId;
}

const URL_RE = /https?:\/\/[^\s<>"'()[\]]+/g;

function shortUrl(url: string) {
  const bare = url.replace(/^https?:\/\/(www\.)?/, "");
  return bare.length > 60 ? bare.slice(0, 57) + "…" : bare;
}

function replaceMatches(
  text: string,
  pattern: RegExp,
  render: (match: string, offset: number) => ReactNode,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    nodes.push(text.slice(start, match.index), render(match[0], match.index));
    start = match.index + match[0].length;
  }
  nodes.push(text.slice(start));
  return nodes;
}

// Plain text with URLs turned into links, displayed shortened so tracking
// URLs stop dominating the layout.
export function Linkified({ text }: { text: string }) {
  return (
    <>
      {replaceMatches(text, URL_RE, (url, offset) => (
        <a
          key={offset}
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="break-all text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
        >
          {shortUrl(url)}
        </a>
      ))}
    </>
  );
}

export const fmtDay = (d: string) =>
  new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export const fmtTime = (d: string) =>
  new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// Compact list-row date: time today, day+month this year, month+year otherwise.
export function fmtDate(d: string) {
  const t = new Date(d);
  const now = new Date();
  if (t.toDateString() === now.toDateString()) return fmtTime(d);
  if (t.getFullYear() === now.getFullYear())
    return t.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return t.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

// Renders text with query terms wrapped in <mark>. Safe: builds React nodes,
// never HTML strings.
export function Highlight({ text, query }: { text: string; query?: string }) {
  const words = (query ?? "").split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return <>{text}</>;
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  return (
    <>
      {replaceMatches(text, re, (word, offset) => (
        <mark
          key={offset}
          className="bg-transparent font-semibold text-amber-500 dark:text-amber-300"
        >
          {word}
        </mark>
      ))}
    </>
  );
}
