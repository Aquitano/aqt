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
import { LibrarySearchGroups } from "@/components/library-search";
import { MailboxSelect } from "@/components/mailbox-select";
import {
  browseThreads,
  SEARCH_PAGE,
  type Message,
  type SourceStat,
  type SearchParams,
} from "@/lib/api";
import { fmtDate, Highlight, SourceBadge } from "@/lib/format";
import { find } from "@/lib/library-api";

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
    match: params?.match ?? "any",
    fuzzy: params?.fuzzy ?? 1,
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
  { value: "any", label: "Any words" },
  { value: "all", label: "All words" },
  { value: "phrase", label: "Exact phrase" },
];

const fullDate = /^[1-9]\d{3}-\d{2}-\d{2}$/;

function searchFrom(form: SearchForm): SearchParams {
  return {
    q: form.q.trim(),
    source: form.source || undefined,
    from: form.from || undefined,
    to: form.to || undefined,
    person: form.person || undefined,
    match: form.match,
    fuzzy: form.fuzzy,
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

export function selectMessage(m: Message): Selection {
  if (m.ref) return { kind: "message", id: m.ref };
  return m.thread_id
    ? { kind: "thread", source: m.source, threadId: m.thread_id, flashId: m.id }
    : { kind: "message", id: String(m.id) };
}

function isSelected(m: Message, selection: Selection) {
  if (selection?.kind === "thread") return selection.flashId === m.id;
  return selection?.kind === "message" && (selection.id === m.ref || selection.id === String(m.id));
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
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<Awaited<ReturnType<typeof find>>> => {
      const empty = {
        messages: [],
        items: [],
        activity: [],
        collections: [],
        files: [],
        attachments: [],
        pages: [],
        coverage: [],
      };
      if (!params) return empty;
      if (params.q) return find(params, pageParam);
      const groups = await browseThreads({ ...params, order: "desc", offset: pageParam });
      return {
        ...empty,
        messages: groups.map((group) => ({
          id: group.last_id,
          source: group.source,
          thread_id: group.thread_id,
          sender: group.sender,
          subject: group.subject,
          body: group.preview,
          sent_at: group.last_at,
        })),
      };
    },
    getNextPageParam: (last, pages) =>
      [
        last.messages,
        last.items,
        last.activity,
        last.collections,
        last.files,
        last.attachments,
        last.pages,
      ].some((group) => group.length === SEARCH_PAGE) && pages.length * SEARCH_PAGE <= 10000
        ? pages.length * SEARCH_PAGE
        : undefined,
  });

  const hits = q.data?.pages.flatMap((page) => page.messages) ?? [];
  const libraryHits =
    q.data?.pages.some((page) =>
      [page.items, page.activity, page.collections, page.files, page.attachments, page.pages].some(
        (group) => group.length > 0,
      ),
    ) ?? false;

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
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={form.fuzzy > 0}
              disabled={form.match === "phrase"}
              onChange={(e) => submit({ fuzzy: e.target.checked ? 1 : 0 })}
            />
            Allow typos
          </label>
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
        ) : params && hits.length === 0 && !libraryHits ? (
          <>
            <LibrarySearchGroups pages={q.data?.pages ?? []} selection={selection} />
            <div className="py-12 text-center text-sm text-muted-foreground">
              No matching records in the available sources. Coverage gaps remain unknown.
            </div>
          </>
        ) : (
          <>
            {q.data && <LibrarySearchGroups pages={q.data.pages} selection={selection} />}
            {hits.length > 0 && (
              <h3 className="px-3 py-2 text-xs font-semibold text-muted-foreground">
                Messages · {hits.length} shown
              </h3>
            )}
            {hits.map((m) => (
              <HitRow
                key={m.id}
                m={m}
                query={params?.q}
                selected={isSelected(m, selection)}
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
