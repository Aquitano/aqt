import { Alert, AlertDescription, AlertTitle } from "@aqt/ui/components/alert";
import { Button } from "@aqt/ui/components/button";
import { Input } from "@aqt/ui/components/input";
import { Kbd } from "@aqt/ui/components/kbd";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aqt/ui/components/select";
import { Skeleton } from "@aqt/ui/components/skeleton";
import { cn } from "@aqt/ui/lib/utils";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Search as SearchIcon } from "lucide-react";
import { useState } from "react";

import type { Selection } from "@/components/detail-pane";
import { MailboxSelect } from "@/components/mailbox-select";
import {
  browseThreads,
  find,
  SEARCH_PAGE,
  type FilePlace,
  type SearchHit,
  type SearchParams,
  type SearchResult,
  type SourceStat,
} from "@/lib/api";
import { fmtDate, Highlight, SourceBadge } from "@/lib/format";
import { getActivityRecord } from "@/lib/library-api";

type SearchForm = Required<Omit<SearchParams, "offset" | "mailbox_id" | "has_attachment">> &
  Pick<SearchParams, "mailbox_id" | "has_attachment">;

function formFrom(params: SearchParams | null): SearchForm {
  return {
    q: params?.q ?? "",
    source: params?.source ?? "",
    from: params?.from ?? "",
    to: params?.to ?? "",
    person: params?.person ?? "",
    since: params?.since ?? "",
    until: params?.until ?? "",
    subject: params?.subject ?? "",
    match: params?.match ?? "all",
    mailbox_id: params?.mailbox_id,
    has_attachment: params?.has_attachment,
  };
}

const ATTACHMENT_FILTERS = [
  { value: "any", label: "Any attachment status" },
  { value: "true", label: "Has attachments" },
  { value: "false", label: "No attachments" },
];

const MATCH_MODES: { value: SearchForm["match"]; label: string }[] = [
  { value: "all", label: "Every word" },
  { value: "any", label: "Any word" },
];

// A search pages by offset; browsing continues after the last thread's ref.
interface PageCursor {
  offset: number;
  after?: string;
}
const firstPage: PageCursor = { offset: 0 };

const fullDate = /^[1-9]\d{3}-\d{2}-\d{2}$/;

function searchFrom(form: SearchForm): SearchParams {
  return {
    q: form.q.trim(),
    source: form.source || undefined,
    from: form.from || undefined,
    to: form.to || undefined,
    person: form.person || undefined,
    match: form.match,
    since: fullDate.test(form.since) ? form.since : undefined,
    until: fullDate.test(form.until) ? form.until : undefined,
    mailbox_id: form.mailbox_id,
    subject: form.subject || undefined,
    has_attachment: form.has_attachment,
  };
}

// Typing a year passes through 0002, 0020 and 0202 before it reaches 2024.
const completeDate = (input: HTMLInputElement) =>
  !input.validity.badInput && (input.value === "" || fullDate.test(input.value));

export function selectMessage(m: { ref: string }): Selection {
  return { kind: "message", ref: m.ref };
}

// selectionOf is what opening a hit shows. A file only on disks has no bytes
// here to show, and activity opens its item, which getActivityRecord names.
function selectionOf(hit: SearchHit): Selection | "activity" {
  if (hit.kind === "activity") return "activity";
  if (hit.kind === "file") {
    return hit.blake3 && hit.places?.some((p) => p.kind !== "disk")
      ? { kind: "file", file: { blake3: hit.blake3, filename: hit.title } }
      : null;
  }
  if (!hit.ref) return null;
  return hit.kind === "message" ? selectMessage({ ref: hit.ref }) : { kind: hit.kind, id: hit.ref };
}

function isSelected(hit: SearchHit, selection: Selection) {
  if (selection === null) return false;
  if (selection.kind === "thread") return hit.kind === "message" && selection.flashRef === hit.ref;
  if (selection.kind === "message") return hit.kind === "message" && selection.ref === hit.ref;
  if (selection.kind === "file") return hit.kind === "file" && selection.file.blake3 === hit.blake3;
  if (selection.kind === "item" || selection.kind === "collection" || selection.kind === "page")
    return hit.kind === selection.kind && selection.id === hit.ref;
  return false;
}

function placeLabel(place: FilePlace) {
  if (place.kind === "message") return `attached as ${place.name}`;
  if (place.kind === "library_file") return `library file ${place.name}`;
  const state = `${place.missing ? " (missing)" : ""}${place.previous ? " (earlier version)" : ""}`;
  return `${place.volume}:${place.path}${state}`;
}

function HitRow({
  hit,
  query,
  selected,
  onClick,
}: {
  hit: SearchHit;
  query?: string;
  selected: boolean;
  onClick?: () => void;
}) {
  const places = hit.places ?? [];
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      data-row
      data-selected={selected || undefined}
      className={cn(
        "block w-full rounded-lg border border-transparent px-2.5 py-2 text-left enabled:hover:bg-accent/50",
        selected && "border-border bg-accent",
      )}
    >
      <div className="flex items-baseline gap-2">
        {hit.source ? <SourceBadge source={hit.source} /> : null}
        <span className="shrink-0 text-xs text-muted-foreground">{hit.type || hit.kind}</span>
        <span className="truncate text-sm font-semibold">
          <Highlight text={hit.title || "Untitled"} query={query} />
        </span>
        {hit.at ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground/70 tabular-nums">
            {fmtDate(hit.at)}
          </span>
        ) : null}
      </div>
      {hit.snippet ? (
        <div className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">
          <Highlight text={hit.snippet} query={query} />
        </div>
      ) : null}
      {places.length > 0 ? (
        <div className="mt-0.5 truncate text-xs text-muted-foreground/70">
          {places.slice(0, 2).map(placeLabel).join(" · ")}
          {(hit.place_count ?? places.length) > 2
            ? ` · ${(hit.place_count ?? places.length) - 2} more`
            : ""}
        </div>
      ) : null}
    </button>
  );
}

export function ListSkeleton() {
  return (
    <div className="space-y-2 px-2.5 py-2">
      {["one", "two", "three", "four", "five", "six", "seven", "eight"].map((key) => (
        <div key={key} className="space-y-1.5 py-1">
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
  params,
  onSearch,
}: {
  stats: SourceStat[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  params: SearchParams | null;
  onSearch: (params: SearchParams) => void;
}) {
  const paramsKey = JSON.stringify(params);
  const [form, setForm] = useState(() => formFrom(params));
  const [formKey, setFormKey] = useState(paramsKey);
  if (formKey !== paramsKey) {
    setFormKey(paramsKey);
    setForm(formFrom(params));
  }
  const edit = (patch: Partial<SearchForm>) => setForm((current) => ({ ...current, ...patch }));
  const submit = (patch: Partial<SearchForm> = {}) => {
    const next = { ...form, ...patch };
    setForm(next);
    onSearch(searchFrom(next));
  };

  const q = useInfiniteQuery({
    queryKey: ["find", params],
    enabled: params !== null,
    initialPageParam: firstPage,
    queryFn: async ({ pageParam }): Promise<SearchResult> => {
      if (!params) return { hits: [], counts: [], coverage: [] };
      if (params.q) return find(params, pageParam.offset);
      const groups = await browseThreads({ ...params, order: "desc", after: pageParam.after });
      return {
        counts: [],
        coverage: [],
        hits: groups.map((group) => ({
          kind: "message" as const,
          ref: group.last_ref,
          source: group.source,
          thread_id: group.thread_id,
          title: group.subject || group.sender,
          snippet: group.preview,
          at: group.last_at,
          score: 0,
          matched: [],
        })),
      };
    },
    getNextPageParam: (last, pages) =>
      last.hits.length === SEARCH_PAGE && pages.length * SEARCH_PAGE <= 10000
        ? { offset: pages.length * SEARCH_PAGE, after: last.hits.at(-1)?.ref }
        : undefined,
  });

  const hits = q.data?.pages.flatMap((page) => page.hits) ?? [];
  const first = q.data?.pages[0];
  const clickHandler = (hit: SearchHit): (() => void) | undefined => {
    const next = selectionOf(hit);
    const ref = hit.ref;
    if (next === "activity")
      return ref
        ? () => void getActivityRecord(ref).then((a) => onSelect({ kind: "item", id: a.item_id }))
        : undefined;
    return next ? () => onSelect(next) : undefined;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-3 pt-3 pb-2">
        <div className="relative">
          <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            ref={searchRef}
            value={form.q}
            onChange={(e) => edit({ q: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Search messages, media, files and knowledge…"
            className="pr-8 pl-8"
            autoFocus
          />
          <Kbd className="absolute top-1/2 right-2.5 -translate-y-1/2">/</Kbd>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Source"
            list="search-sources"
            placeholder="all sources"
            value={form.source}
            onChange={(event) => edit({ source: event.target.value, mailbox_id: undefined })}
            onKeyDown={(event) => event.key === "Enter" && submit()}
            className="h-8 min-w-28 flex-1 text-xs"
          />
          <datalist id="search-sources">
            {stats.map((stat) => (
              <option key={stat.source} value={stat.source} />
            ))}
          </datalist>
          <Input
            value={form.from}
            onChange={(e) => edit({ from: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="sender"
            className="h-8 flex-1 text-xs"
          />
          <Input
            type="date"
            value={form.since}
            onChange={(e) => (completeDate(e.target) ? submit : edit)({ since: e.target.value })}
            className="h-8 flex-1 text-xs [color-scheme:dark]"
          />
          <Input
            type="date"
            value={form.until}
            onChange={(e) => (completeDate(e.target) ? submit : edit)({ until: e.target.value })}
            className="h-8 flex-1 text-xs [color-scheme:dark]"
          />
        </div>
        <MailboxSelect
          source={form.source || undefined}
          value={form.mailbox_id}
          onChange={(id) => submit({ mailbox_id: id })}
        />
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Subject contains"
            placeholder="subject contains"
            value={form.subject}
            onChange={(event) => edit({ subject: event.target.value })}
            onKeyDown={(event) => event.key === "Enter" && submit()}
          />
          <Select
            items={ATTACHMENT_FILTERS}
            value={form.has_attachment === undefined ? "any" : String(form.has_attachment)}
            onValueChange={(value) =>
              submit({
                has_attachment: value === null || value === "any" ? undefined : value === "true",
              })
            }
          >
            <SelectTrigger aria-label="Attachment presence">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {ATTACHMENT_FILTERS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button onClick={() => submit()}>Search</Button>
        </div>
        {params && !params.q && (
          <p className="text-xs text-muted-foreground">
            Matching conversations, newest first. Open one to read the full conversation.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            items={MATCH_MODES}
            value={form.match}
            onValueChange={(next) => {
              if (next !== null) submit({ match: next });
            }}
          >
            <SelectTrigger size="sm" className="text-xs" aria-label="Match mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {MATCH_MODES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Input
            value={form.to}
            onChange={(e) => edit({ to: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="recipient"
            aria-label="Recipient"
            className="h-8 min-w-24 flex-1 text-xs"
          />
          <Input
            value={form.person}
            onChange={(e) => edit({ person: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="contact name"
            aria-label="Contact name"
            className="h-8 min-w-24 flex-1 text-xs"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {q.isLoading ? (
          <ListSkeleton />
        ) : q.isError ? (
          <div className="py-12 text-center text-sm text-muted-foreground">{q.error.message}</div>
        ) : (
          <>
            {first && first.coverage.length > 0 && (
              <Alert className="my-2">
                <AlertTitle>Search coverage</AlertTitle>
                <AlertDescription>
                  {first.coverage.map((note) => (
                    <p key={note}>{note}</p>
                  ))}
                </AlertDescription>
              </Alert>
            )}
            {first && first.counts.length > 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {first.counts.map((count) => `${count.matches} ${count.kind}`).join(" · ")}
              </p>
            )}
            {params && hits.length === 0 && (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No matching records in the available sources. Coverage gaps remain unknown.
              </div>
            )}
            {hits.map((hit, index) => (
              <HitRow
                key={`${hit.kind}:${hit.ref ?? index}`}
                hit={hit}
                query={params?.q}
                selected={isSelected(hit, selection)}
                onClick={clickHandler(hit)}
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
