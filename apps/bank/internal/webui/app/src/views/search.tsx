import { useInfiniteQuery } from "@tanstack/react-query";
import { Search as SearchIcon } from "lucide-react";
import { useState } from "react";

import type { Selection } from "@/components/detail-pane";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { search, SEARCH_PAGE, type Message, type SourceStat } from "@/lib/api";
import { fmtDate, Highlight, SourceBadge } from "@/lib/format";
import { cn } from "@/lib/utils";

const ALL = "__all__";

export function selectMessage(m: Message): Selection {
  return m.thread_id
    ? {
        kind: "thread",
        source: m.source,
        threadId: m.thread_id,
        title: m.subject || m.thread_id,
        flashId: m.id,
      }
    : { kind: "message", id: m.id };
}

export function HitRow({
  m,
  query,
  selected,
  onClick,
}: {
  m: Message;
  query?: string;
  selected: boolean;
  onClick: () => void;
}) {
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
        <SourceBadge source={m.source} />
        <span className="truncate text-sm font-semibold">{m.sender || "—"}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground/70 tabular-nums">
          {fmtDate(m.sent_at)}
        </span>
      </div>
      {m.subject ? (
        <div className="truncate text-[13px] text-foreground/85">
          <Highlight text={m.subject} query={query} />
        </div>
      ) : null}
      <div className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">
        {m.attachment_snippet ? (
          <span className="text-muted-foreground/60 italic">in attachment · </span>
        ) : null}
        <Highlight text={m.attachment_snippet || m.snippet || m.body || ""} query={query} />
      </div>
    </button>
  );
}

export function ListSkeleton() {
  return (
    <div className="space-y-2 px-2.5 py-2">
      {[...Array(8)].map((_, i) => (
        <div key={i} className="space-y-1.5 py-1">
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}

export function SearchView({
  stats,
  selection,
  onSelect,
  searchRef,
}: {
  stats: SourceStat[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [input, setInput] = useState("");
  const [source, setSource] = useState(ALL);
  const [from, setFrom] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [params, setParams] = useState<{
    q: string;
    source?: string;
    from?: string;
    since?: string;
    until?: string;
  } | null>(null);

  const q = useInfiniteQuery({
    queryKey: ["search", params],
    enabled: params !== null,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => search({ ...params!, offset: pageParam }),
    getNextPageParam: (last, pages) =>
      last.length === SEARCH_PAGE ? pages.length * SEARCH_PAGE : undefined,
  });

  const submit = (over?: { source?: string; from?: string; since?: string; until?: string }) => {
    const query = input.trim();
    if (!query) return;
    const p = { source: source === ALL ? "" : source, from, since, until, ...over };
    setParams({
      q: query,
      source: p.source || undefined,
      from: p.from || undefined,
      since: p.since || undefined,
      until: p.until || undefined,
    });
  };

  const hits = q.data?.pages.flat() ?? [];
  const selectedId =
    selection?.kind === "thread"
      ? selection.flashId
      : selection?.kind === "message"
        ? selection.id
        : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-3 pt-3 pb-2">
        <div className="relative">
          <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            ref={searchRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Search the archive…"
            className="pr-8 pl-8"
            autoFocus
          />
          <Kbd className="absolute top-1/2 right-2.5 -translate-y-1/2">/</Kbd>
        </div>
        <div className="flex gap-2">
          <Select
            value={source}
            onValueChange={(v) => {
              setSource(v);
              submit({ source: v === ALL ? "" : v });
            }}
          >
            <SelectTrigger size="sm" className="flex-1 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>all sources</SelectItem>
              {stats.map((s) => (
                <SelectItem key={s.source} value={s.source}>
                  {s.source}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="sender"
            className="h-8 flex-1 text-xs"
          />
          <Input
            type="date"
            value={since}
            onChange={(e) => {
              setSince(e.target.value);
              submit({ since: e.target.value });
            }}
            className="h-8 flex-1 text-xs [color-scheme:dark]"
          />
          <Input
            type="date"
            value={until}
            onChange={(e) => {
              setUntil(e.target.value);
              submit({ until: e.target.value });
            }}
            className="h-8 flex-1 text-xs [color-scheme:dark]"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {q.isLoading ? (
          <ListSkeleton />
        ) : q.isError ? (
          <div className="py-12 text-center text-sm text-muted-foreground">{q.error.message}</div>
        ) : params && hits.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">No results</div>
        ) : (
          <>
            {hits.map((m) => (
              <HitRow
                key={m.id}
                m={m}
                query={params?.q}
                selected={m.id === selectedId}
                onClick={() => onSelect(selectMessage(m))}
              />
            ))}
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
