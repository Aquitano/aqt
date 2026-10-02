import { useInfiniteQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import { useState } from "react";

import type { Selection } from "@/components/detail-pane";
import { MailboxSelect } from "@/components/mailbox-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { browseThreads, BROWSE_PAGE, type SourceStat, type ThreadGroup } from "@/lib/api";
import { fmtDate, SourceBadge } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ListSkeleton } from "@/views/search";

export const ALL_SOURCES = "__all__";

// Raw WhatsApp JIDs make useless titles; unnamed group chats are titled by
// their participants instead, the way messengers do it.
const JID = /@(g\.us|s\.whatsapp\.net)$/;

function groupTitle(g: ThreadGroup) {
  if (g.subject) return g.subject;
  if (JID.test(g.thread_id) && g.members) return g.members;
  return !g.thread_id ? g.sender || "—" : g.thread_id;
}

function groupSelection(g: ThreadGroup): Selection {
  return !g.thread_id
    ? { kind: "message", id: g.last_id }
    : { kind: "thread", source: g.source, threadId: g.thread_id, title: groupTitle(g) };
}

function GroupRow({
  g,
  selected,
  onClick,
}: {
  g: ThreadGroup;
  selected: boolean;
  onClick: () => void;
}) {
  const threaded = Boolean(g.thread_id);
  const title = groupTitle(g);
  return (
    <button
      onClick={onClick}
      data-row
      data-selected={selected || undefined}
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
            {g.n} matching messages
          </Badge>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground/70 tabular-nums">
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
  );
}

export function BrowseView({
  stats,
  selection,
  onSelect,
  source,
  onSourceChange,
}: {
  stats: SourceStat[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  source: string;
  onSourceChange: (s: string) => void;
}) {
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [mailbox, setMailbox] = useState<{ source: string; id?: number }>({ source });
  const mailboxId = mailbox.source === source ? mailbox.id : undefined;

  const q = useInfiniteQuery({
    queryKey: ["browse", source, order, mailboxId],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      browseThreads({
        source: source === ALL_SOURCES ? undefined : source,
        mailbox_id: mailboxId,
        order,
        offset: pageParam,
      }),
    getNextPageParam: (last, pages) =>
      last.length === BROWSE_PAGE ? pages.length * BROWSE_PAGE : undefined,
  });

  const groups = q.data?.pages.flat() ?? [];

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
        <Select
          value={order}
          onValueChange={(v) => {
            if (v === "asc" || v === "desc") setOrder(v);
          }}
        >
          <SelectTrigger size="sm" className="flex-1 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="desc">newest first</SelectItem>
            <SelectItem value="asc">oldest first</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="px-3 pb-2">
        <MailboxSelect
          source={source === ALL_SOURCES ? undefined : source}
          value={mailboxId}
          onChange={(id) => setMailbox({ source, id })}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {q.isLoading ? (
          <ListSkeleton />
        ) : q.isError ? (
          <div className="py-12 text-center text-sm text-muted-foreground">{q.error.message}</div>
        ) : (
          <>
            {groups.map((g) => {
              const sel = groupSelection(g);
              const selected =
                selection?.kind === "thread"
                  ? Boolean(g.thread_id) &&
                    selection.source === g.source &&
                    selection.threadId === g.thread_id
                  : selection?.kind === "message" && !g.thread_id && selection.id === g.last_id;
              return (
                <GroupRow
                  key={JSON.stringify([g.source, g.thread_id, g.thread_id ? null : g.last_id])}
                  g={g}
                  selected={selected}
                  onClick={() => onSelect(sel)}
                />
              );
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
  );
}
