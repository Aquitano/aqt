import { Download, Paperclip } from "lucide-react";
import { memo, useEffect, useRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import type { Message as BankMessage } from "@/lib/api";
import { fmtDay, fmtTime, isMarkdownSource, isMe, Linkified, sourceHue } from "@/lib/format";
import { cn } from "@/lib/utils";

function initials(name: string) {
  const words = name.replace(/<.*/, "").trim().split(/\s+/);
  return (
    words
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

function SenderAvatar({ name }: { name: string }) {
  const h = sourceHue(name.toLowerCase());
  return (
    <Avatar className="size-7">
      <AvatarFallback
        className="text-[10px] font-semibold"
        style={{ background: `hsl(${h} 35% 25%)`, color: `hsl(${h} 65% 80%)` }}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

function fmtBytes(n?: number) {
  if (!n) return undefined;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Attachments({ m }: { m: BankMessage }) {
  if (!m.attachments?.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {m.attachments.map((a) => (
        <a
          key={a.sha256 + a.filename}
          href={`/v1/blobs/${a.sha256}`}
          download={a.filename}
          className="group/att block"
        >
          <Attachment size="sm" className="hover:bg-accent">
            <AttachmentMedia>
              <Paperclip className="size-3.5" />
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>{a.filename}</AttachmentTitle>
              {fmtBytes(a.size_bytes) && (
                <AttachmentDescription>{fmtBytes(a.size_bytes)}</AttachmentDescription>
              )}
            </AttachmentContent>
            <Download className="mr-1 size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover/att:opacity-100" />
          </Attachment>
        </a>
      ))}
    </div>
  );
}

// WhatsApp media placeholders written by wa-extract ("[photo] caption")
const MEDIA_TAG =
  /^\[(photo|video|voice message|GIF|sticker|document|location|contact card[^\]]*)\]\s*/;

// AI transcripts are markdown and render as such; everything else is plain
// text with clickable, shortened URLs. Memoized: archive messages never change.
const Body = memo(function Body({ m }: { m: BankMessage }) {
  if (isMarkdownSource(m.source))
    return (
      <div className="prose prose-sm max-w-none prose-invert prose-headings:my-2 prose-p:my-1.5 prose-a:break-all prose-pre:overflow-x-auto prose-pre:whitespace-pre-wrap">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.body ?? ""}</ReactMarkdown>
      </div>
    );
  const body = m.body ?? "";
  const tag = body.match(MEDIA_TAG);
  return (
    <span className="whitespace-pre-wrap">
      {tag && (
        <span className="mr-1 inline-flex items-center gap-1 text-xs italic opacity-60">
          <Paperclip className="size-3" />
          {tag[1]}
        </span>
      )}
      <Linkified text={tag ? body.slice(tag[0].length) : body} />
    </span>
  );
});

// Consecutive messages from the same sender on the same day render as one
// MessageGroup: header once, avatar once, timestamps on hover (always on the
// last bubble of the group).
interface Run {
  day: string;
  sender: string;
  me: boolean;
  messages: BankMessage[];
}

function buildRuns(messages: BankMessage[]): Run[] {
  const runs: Run[] = [];
  for (const m of messages) {
    const day = fmtDay(m.sent_at);
    const sender = m.sender || "—";
    const last = runs[runs.length - 1];
    if (last && last.day === day && last.sender === sender) last.messages.push(m);
    else runs.push({ day, sender, me: isMe(sender), messages: [m] });
  }
  return runs;
}

function DaySeparator({ day }: { day: string }) {
  return (
    <div className="mt-6 mb-3 flex items-center gap-3 text-[11px] font-medium tracking-wide text-muted-foreground/60 first:mt-0">
      <div className="h-px flex-1 bg-border/60" />
      {day}
      <div className="h-px flex-1 bg-border/60" />
    </div>
  );
}

// Timestamps appear exactly once per run — merged into the sender header for
// group-chat runs, as a small footer on the last bubble otherwise. Every
// bubble still reveals its precise time on hover via the native tooltip.
function RunBlock({ run, flashId, solo }: { run: Run; flashId?: number | null; solo: boolean }) {
  const bubbles = run.messages.map((m, i) => {
    const lastOfRun = i === run.messages.length - 1;
    const showHeader = i === 0 && !run.me && !solo;
    const showFooter = lastOfRun && (run.me || solo);
    return (
      <Message key={m.id} align={run.me ? "end" : "start"} data-mid={m.id}>
        {!run.me && (
          <MessageAvatar className={cn(!lastOfRun && "invisible")}>
            <SenderAvatar name={run.sender} />
          </MessageAvatar>
        )}
        <MessageContent className="gap-1">
          {showHeader && (
            <MessageHeader className="gap-1.5 text-[11px]">
              {run.sender}
              <span className="font-normal text-muted-foreground/50">{fmtTime(m.sent_at)}</span>
            </MessageHeader>
          )}
          <Bubble
            variant="muted"
            title={`${fmtDay(m.sent_at)}, ${fmtTime(m.sent_at)}`}
            className={cn(
              run.me &&
                "*:data-[slot=bubble-content]:bg-(--bubble-me)! *:data-[slot=bubble-content]:text-(--bubble-me-foreground)!",
              m.id === flashId && "rounded-xl ring-2 ring-amber-400/70",
            )}
          >
            <BubbleContent>
              {m.subject ? <div className="mb-1 font-semibold">{m.subject}</div> : null}
              <Body m={m} />
              <Attachments m={m} />
            </BubbleContent>
          </Bubble>
          {showFooter && (
            <MessageFooter className="text-[10px] text-muted-foreground/50">
              {fmtTime(m.sent_at)}
            </MessageFooter>
          )}
        </MessageContent>
      </Message>
    );
  });
  return run.messages.length > 1 ? (
    <MessageGroup className="gap-0.5">{bubbles}</MessageGroup>
  ) : (
    bubbles[0]
  );
}

// A lone message (typically an email) is a document, not a chat: read
// top-down, full width, sender line instead of an avatar bubble.
function DocumentView({ title, meta, m }: { title: ReactNode; meta: string; m: BankMessage }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-baseline gap-2.5 border-b px-6 py-3">
        <span className="truncate text-base font-semibold">{title}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{meta}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto max-w-3xl px-6 py-6">
          {m.subject && <h1 className="mb-1 text-lg font-semibold">{m.subject}</h1>}
          <div className="mb-5 flex flex-wrap items-baseline gap-x-2 border-b pb-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80">{m.sender || "—"}</span>
            {m.recipients?.length ? <span>→ {m.recipients.join(", ")}</span> : null}
            <span className="ml-auto">
              {fmtDay(m.sent_at)}, {fmtTime(m.sent_at)}
            </span>
          </div>
          <div className="text-sm leading-relaxed">
            <Body m={m} />
          </div>
          <div className="mt-4">
            <Attachments m={m} />
          </div>
        </article>
      </div>
    </div>
  );
}

export function Conversation({
  title,
  meta,
  messages,
  flashId,
}: {
  title: ReactNode;
  meta: string;
  messages: BankMessage[];
  flashId?: number | null;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);

  // The scroller starts pinned to the bottom; a flashed search hit overrides
  // that and centers the hit instead.
  useEffect(() => {
    if (!flashId) return;
    const target = viewportRef.current?.querySelector(`[data-mid="${flashId}"]`);
    target?.scrollIntoView({ block: "center" });
  }, [messages, flashId]);

  if (messages.length === 1) return <DocumentView title={title} meta={meta} m={messages[0]} />;

  const runs = buildRuns(messages);
  // 1:1 chats need no per-run sender headers; the title already says who
  const senders = new Set(runs.filter((r) => !r.me).map((r) => r.sender));
  const solo = senders.size <= 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-baseline gap-2.5 border-b px-6 py-3">
        <span className="truncate text-base font-semibold">{title}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{meta}</span>
      </div>
      <MessageScrollerProvider>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport ref={viewportRef}>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-0 px-6 py-5">
              {runs.map((run, i) => {
                const sep = i === 0 || runs[i - 1].day !== run.day;
                return (
                  <div key={run.messages[0].id} className="contents">
                    {sep && <DaySeparator day={run.day} />}
                    <div className={cn(!sep && i > 0 && "mt-3.5")}>
                      <RunBlock run={run} flashId={flashId} solo={solo} />
                    </div>
                  </div>
                );
              })}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}
