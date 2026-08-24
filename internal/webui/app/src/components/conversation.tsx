import { useEffect, useRef, type ReactNode } from "react"
import { Download, Paperclip } from "lucide-react"
import type { Message as BankMessage } from "@/lib/api"
import { fmtDay, fmtTime, isMe, sourceHue } from "@/lib/format"
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { cn } from "@/lib/utils"

function initials(name: string) {
  const words = name.replace(/<.*/, "").trim().split(/\s+/)
  return (
    words
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  )
}

function SenderAvatar({ name }: { name: string }) {
  const h = sourceHue(name.toLowerCase())
  return (
    <Avatar className="size-7">
      <AvatarFallback
        className="text-[10px] font-semibold"
        style={{ background: `hsl(${h} 35% 25%)`, color: `hsl(${h} 65% 80%)` }}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  )
}

function fmtBytes(n?: number) {
  if (!n) return undefined
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function Attachments({ m }: { m: BankMessage }) {
  if (!m.attachments?.length) return null
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
  )
}

// Consecutive messages from the same sender on the same day render as one
// MessageGroup: header once, avatar once, timestamps on hover (always on the
// last bubble of the group).
interface Run {
  day: string
  sender: string
  me: boolean
  messages: BankMessage[]
}

function buildRuns(messages: BankMessage[]): Run[] {
  const runs: Run[] = []
  for (const m of messages) {
    const day = fmtDay(m.sent_at)
    const sender = m.sender || "—"
    const last = runs[runs.length - 1]
    if (last && last.day === day && last.sender === sender) last.messages.push(m)
    else runs.push({ day, sender, me: isMe(sender), messages: [m] })
  }
  return runs
}

function DaySeparator({ day }: { day: string }) {
  return (
    <div className="my-3 flex items-center gap-3 text-xs text-muted-foreground/70">
      <div className="h-px flex-1 bg-border" />
      {day}
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

function RunBlock({ run, flashId, solo }: { run: Run; flashId?: number | null; solo: boolean }) {
  const bubbles = run.messages.map((m, i) => {
    const lastOfRun = i === run.messages.length - 1
    return (
      <Message key={m.id} align={run.me ? "end" : "start"} data-mid={m.id}>
        {!run.me && (
          <MessageAvatar className={cn(!lastOfRun && "invisible")}>
            <SenderAvatar name={run.sender} />
          </MessageAvatar>
        )}
        <MessageContent>
          {i === 0 && !run.me && !solo && <MessageHeader>{run.sender}</MessageHeader>}
          <Bubble
            variant={run.me ? "tinted" : "muted"}
            className={cn(m.id === flashId && "rounded-xl ring-2 ring-amber-400/70")}
          >
            <BubbleContent>
              {m.subject ? <div className="mb-1 font-semibold">{m.subject}</div> : null}
              <span className="whitespace-pre-wrap">{m.body}</span>
              <Attachments m={m} />
            </BubbleContent>
          </Bubble>
          <MessageFooter
            className={cn(
              "text-[11px] text-muted-foreground/60",
              !lastOfRun && "opacity-0 transition-opacity group-hover/message:opacity-100",
            )}
          >
            {fmtTime(m.sent_at)}
          </MessageFooter>
        </MessageContent>
      </Message>
    )
  })
  return run.messages.length > 1 ? <MessageGroup>{bubbles}</MessageGroup> : bubbles[0]
}

export function Conversation({
  title,
  meta,
  messages,
  flashId,
}: {
  title: ReactNode
  meta: string
  messages: BankMessage[]
  flashId?: number | null
}) {
  const viewportRef = useRef<HTMLDivElement>(null)

  // The scroller starts pinned to the bottom; a flashed search hit overrides
  // that and centers the hit instead.
  useEffect(() => {
    if (!flashId) return
    const target = viewportRef.current?.querySelector(`[data-mid="${flashId}"]`)
    target?.scrollIntoView({ block: "center" })
  }, [messages, flashId])

  const runs = buildRuns(messages)
  // 1:1 chats need no per-run sender headers; the title already says who
  const senders = new Set(runs.filter((r) => !r.me).map((r) => r.sender))
  const solo = senders.size <= 1

  let day = ""
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-baseline gap-2.5 border-b px-6 py-3">
        <span className="truncate text-base font-semibold">{title}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{meta}</span>
      </div>
      <MessageScrollerProvider>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport ref={viewportRef}>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-1.5 px-6 py-4">
              {runs.map((run) => {
                const sep = run.day !== day
                day = run.day
                return (
                  <div key={run.messages[0].id} className="contents">
                    {sep && <DaySeparator day={run.day} />}
                    <RunBlock run={run} flashId={flashId} solo={solo} />
                  </div>
                )
              })}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  )
}
