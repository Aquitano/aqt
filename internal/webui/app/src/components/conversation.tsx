import { useEffect, useRef, type ReactNode } from "react"
import { Paperclip } from "lucide-react"
import type { Message } from "@/lib/api"
import { fmtDay, fmtTime, isMe } from "@/lib/format"
import { cn } from "@/lib/utils"

function AttachmentChips({ m }: { m: Message }) {
  if (!m.attachments?.length) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {m.attachments.map((a) => (
        <a
          key={a.sha256 + a.filename}
          href={`/v1/blobs/${a.sha256}`}
          download={a.filename}
          className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary hover:bg-primary/20"
        >
          <Paperclip className="size-3" />
          {a.filename}
        </a>
      ))}
    </div>
  )
}

function Bubble({ m, flash }: { m: Message; flash: boolean }) {
  const me = isMe(m.sender)
  return (
    <div className={cn("group flex max-w-[82%] flex-col", me ? "ml-auto items-end" : "items-start")} data-mid={m.id}>
      <div className="mb-0.5 flex items-baseline gap-2 px-1 text-xs text-muted-foreground">
        <span className="font-medium">{m.sender || "—"}</span>
        <span className="text-muted-foreground/60">{fmtTime(m.sent_at)}</span>
      </div>
      <div
        className={cn(
          "rounded-2xl border px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words shadow-xs",
          me
            ? "rounded-br-md border-primary/20 bg-primary/10"
            : "rounded-bl-md border-border bg-card",
          flash && "ring-2 ring-amber-400/70",
        )}
      >
        {m.subject ? <div className="mb-1 font-semibold">{m.subject}</div> : null}
        {m.body}
        <AttachmentChips m={m} />
      </div>
    </div>
  )
}

export function Conversation({
  title,
  meta,
  messages,
  flashId,
}: {
  title: ReactNode
  meta: string
  messages: Message[]
  flashId?: number | null
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const pane = ref.current?.parentElement
    if (!pane) return
    const target = flashId ? pane.querySelector(`[data-mid="${flashId}"]`) : null
    if (target) target.scrollIntoView({ block: "center" })
    else pane.scrollTop = pane.scrollHeight
  }, [messages, flashId])

  let day = ""
  return (
    <div ref={ref} className="mx-auto max-w-3xl px-6 pb-12">
      <div className="sticky top-0 z-10 mb-4 flex items-baseline gap-2.5 border-b bg-background/95 py-3 backdrop-blur supports-backdrop-filter:bg-background/80">
        <span className="truncate text-base font-semibold">{title}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{meta}</span>
      </div>
      <div className="flex flex-col gap-3">
        {messages.map((m) => {
          const d = fmtDay(m.sent_at)
          const sep = d !== day
          day = d
          return (
            <div key={m.id} className="contents">
              {sep && (
                <div className="my-2 flex items-center gap-3 text-xs text-muted-foreground/70">
                  <div className="h-px flex-1 bg-border" />
                  {d}
                  <div className="h-px flex-1 bg-border" />
                </div>
              )}
              <Bubble m={m} flash={m.id === flashId} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
