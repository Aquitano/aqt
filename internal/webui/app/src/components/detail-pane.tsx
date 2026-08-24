import { useQuery } from "@tanstack/react-query"
import { Inbox } from "lucide-react"
import { getContactMessages, getMessage, getThread } from "@/lib/api"
import { SourceBadge } from "@/lib/format"
import { Skeleton } from "@/components/ui/skeleton"
import { Conversation } from "@/components/conversation"

// What the right-hand pane is showing. A thread selection carries the id of
// the message that triggered it so the pane can scroll to and highlight it.
export type Selection =
  | { kind: "thread"; source: string; threadId: string; title?: string; flashId?: number }
  | { kind: "message"; id: number }
  | { kind: "contact"; name: string }
  | null

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/60">
      <Inbox className="size-8" strokeWidth={1.25} />
      <span className="text-sm">{text}</span>
    </div>
  )
}

function Loading() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-6 py-8">
      {[...Array(5)].map((_, i) => (
        <Skeleton key={i} className={i % 2 ? "ml-auto h-14 w-2/3 rounded-2xl" : "h-14 w-2/3 rounded-2xl"} />
      ))}
    </div>
  )
}

export function DetailPane({ selection }: { selection: Selection }) {
  const q = useQuery({
    queryKey: ["detail", selection],
    enabled: selection !== null,
    queryFn: async () => {
      if (!selection) return null
      switch (selection.kind) {
        case "thread": {
          const t = await getThread(selection.source, selection.threadId)
          return {
            title: (
              <span className="flex items-baseline gap-2">
                <SourceBadge source={selection.source} />
                <span className="truncate">{selection.title || selection.threadId}</span>
              </span>
            ),
            meta: `${t.messages.length} messages${t.truncated ? " (truncated)" : ""}`,
            messages: t.messages,
            flashId: selection.flashId ?? null,
          }
        }
        case "message": {
          const m = await getMessage(selection.id)
          return {
            title: (
              <span className="flex items-baseline gap-2">
                <SourceBadge source={m.source} />
                <span className="truncate">{m.subject || m.sender || "—"}</span>
              </span>
            ),
            meta: new Date(m.sent_at).toLocaleDateString("en-GB", { dateStyle: "long" }),
            messages: [m],
            flashId: null,
          }
        }
        case "contact": {
          const msgs = await getContactMessages(selection.name)
          return {
            title: <span>{selection.name}</span>,
            meta: `${msgs.length} messages across sources`,
            messages: [...msgs].reverse(),
            flashId: null,
          }
        }
      }
    },
  })

  if (!selection) return <Empty text="Select a message or thread" />
  if (q.isLoading) return <Loading />
  if (q.isError) return <Empty text={(q.error as Error).message} />
  if (!q.data) return null
  return (
    <Conversation
      title={q.data.title}
      meta={q.data.meta}
      messages={q.data.messages}
      flashId={q.data.flashId}
    />
  )
}
