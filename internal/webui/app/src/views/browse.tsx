import { useState } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { MessagesSquare } from "lucide-react"
import { browseThreads, BROWSE_PAGE, type SourceStat, type ThreadGroup } from "@/lib/api"
import { fmtDate, SourceBadge } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Selection } from "@/components/detail-pane"
import { ListSkeleton } from "@/views/search"
import { cn } from "@/lib/utils"

export const ALL_SOURCES = "__all__"

function groupSelection(g: ThreadGroup): Selection {
  return g.gid.startsWith("msg:")
    ? { kind: "message", id: g.last_id }
    : { kind: "thread", source: g.source, threadId: g.gid, title: g.subject || g.gid }
}

function GroupRow({
  g,
  selected,
  onClick,
}: {
  g: ThreadGroup
  selected: boolean
  onClick: () => void
}) {
  const threaded = !g.gid.startsWith("msg:")
  const title = g.subject || (threaded ? g.gid : g.sender || "—")
  return (
    <button
      onClick={onClick}
      className={cn(
        "block w-full rounded-lg border border-transparent px-2.5 py-2 text-left hover:bg-accent/50",
        selected && "border-border bg-accent",
      )}
    >
      <div className="flex items-baseline gap-2">
        <SourceBadge source={g.source} />
        <span className="truncate text-sm font-semibold">{title}</span>
        {threaded && g.n > 1 && (
          <Badge variant="secondary" className="h-4 shrink-0 gap-1 px-1.5 text-[10px] font-medium">
            <MessagesSquare className="size-2.5" />
            {g.n}
          </Badge>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground/70">
          {fmtDate(g.last_at)}
        </span>
      </div>
      <div className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">
        {threaded && g.sender ? (
          <span className="text-muted-foreground/70">{g.sender.split("<")[0].trim()}: </span>
        ) : null}
        {g.preview}
      </div>
    </button>
  )
}

export function BrowseView({
  stats,
  selection,
  onSelect,
  source,
  onSourceChange,
}: {
  stats: SourceStat[]
  selection: Selection
  onSelect: (s: Selection) => void
  source: string
  onSourceChange: (s: string) => void
}) {
  const [order, setOrder] = useState<"asc" | "desc">("desc")

  const q = useInfiniteQuery({
    queryKey: ["browse", source, order],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      browseThreads({
        source: source === ALL_SOURCES ? undefined : source,
        order,
        offset: pageParam,
      }),
    getNextPageParam: (last, pages) =>
      last.length === BROWSE_PAGE ? pages.length * BROWSE_PAGE : undefined,
  })

  const groups = q.data?.pages.flat() ?? []
  const selectedKey =
    selection?.kind === "thread"
      ? `${selection.source}/${selection.threadId}`
      : selection?.kind === "message"
        ? `msg/${selection.id}`
        : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 gap-2 px-3 pt-3 pb-2">
        <Select value={source} onValueChange={onSourceChange}>
          <SelectTrigger size="sm" className="flex-1 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SOURCES}>all sources</SelectItem>
            {stats.map((s) => (
              <SelectItem key={s.source} value={s.source}>
                {s.source}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={order} onValueChange={(v) => setOrder(v as "asc" | "desc")}>
          <SelectTrigger size="sm" className="flex-1 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="desc">newest first</SelectItem>
            <SelectItem value="asc">oldest first</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {q.isLoading ? (
          <ListSkeleton />
        ) : q.isError ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {(q.error as Error).message}
          </div>
        ) : (
          <>
            {groups.map((g) => {
              const sel = groupSelection(g)
              const key =
                sel?.kind === "thread" ? `${sel.source}/${sel.threadId}` : `msg/${g.last_id}`
              return (
                <GroupRow
                  key={`${g.source}/${g.gid}`}
                  g={g}
                  selected={key === selectedKey}
                  onClick={() => onSelect(sel)}
                />
              )
            })}
            {q.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                className="mx-1.5 my-2 w-[calc(100%-0.75rem)]"
                disabled={q.isFetchingNextPage}
                onClick={() => q.fetchNextPage()}
              >
                {q.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
