import { Badge } from "@aqt/ui/components/badge";
import { Button } from "@aqt/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@aqt/ui/components/card";
import { Field, FieldGroup, FieldLabel } from "@aqt/ui/components/field";
import { Input } from "@aqt/ui/components/input";
import { Spinner } from "@aqt/ui/components/spinner";
import { Textarea } from "@aqt/ui/components/textarea";
import { cn } from "@aqt/ui/lib/utils";
import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Copy, ListMusic, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";

import { DraftRecovery } from "@/components/draft-recovery";
import {
  Choice,
  ErrorNotice,
  LibraryEmpty,
  LibraryFilters,
  recordedDate,
  SourceLabel,
} from "@/components/library-common";
import { RequestError } from "@/lib/api";
import { appendEntry, moveEntry } from "@/lib/collection-entries";
import { keepLatest, useDraft } from "@/lib/draft";
import {
  createCollection,
  getCollection,
  getCollections,
  getCollectionSnapshots,
  getCollectionSnapshot,
  getItemSummaries,
  getItems,
  LIBRARY_PAGE,
  saveCollection,
  type Collection,
  type CollectionEntry,
  type ItemSummary,
  type SnapshotSummary,
} from "@/lib/library-api";
import { select, useLibraryFilters, type Selection } from "@/lib/navigation";
import { ListSkeleton } from "@/views/search";

const KINDS = ["playlist", "watchlist", "library", "list"];
function AddCollection({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("watchlist");
  const mutation = useMutation({
    mutationFn: () => createCollection({ title: title.trim(), kind, description: "" }),
    onSuccess: async (collection) => {
      await client.invalidateQueries({ queryKey: ["library", "collections"] });
      select({ kind: "collection", id: collection.id });
      onClose();
    },
  });
  return (
    <Card className="m-4 mt-0">
      <CardHeader>
        <CardTitle>New collection</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel htmlFor="collection-title">Name</FieldLabel>
              <Input
                id="collection-title"
                value={title}
                required
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="collection-kind">Kind</FieldLabel>
              <Choice
                id="collection-kind"
                label="Kind"
                value={kind}
                onChange={setKind}
                options={KINDS.map((value) => ({ value, label: value }))}
              />
            </Field>
          </FieldGroup>
          {mutation.isError && <ErrorNotice error={mutation.error} />}
          <div className="flex gap-2">
            <Button type="submit" disabled={!title.trim() || mutation.isPending}>
              {mutation.isPending ? "Creating…" : "Create"}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
export function CollectionsView({ selection }: { selection: Selection }) {
  const [filters, setFilters] = useLibraryFilters("collections");
  const [adding, setAdding] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ["library", "collections", filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getCollections(filters, pageParam),
    getNextPageParam: (last, pages) =>
      last.length === LIBRARY_PAGE ? pages.length * LIBRARY_PAGE : undefined,
  });
  const collections = query.data?.pages.flat() ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start justify-between gap-3 p-4">
        <div>
          <h2 className="text-lg font-semibold">Collections</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Playlists, watchlists and saved libraries.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setAdding(!adding)}>
          <Plus data-icon="inline-start" />
          New
        </Button>
      </div>
      <LibraryFilters
        key={JSON.stringify(filters)}
        filters={filters}
        noun="collections"
        kinds={KINDS}
        onChange={setFilters}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {adding && <AddCollection onClose={() => setAdding(false)} />}
        {query.isPending ? (
          <ListSkeleton />
        ) : query.isError ? (
          <ErrorNotice error={query.error} />
        ) : !collections.length ? (
          <LibraryEmpty
            title="No matching collections"
            description="Create a personal watchlist or import a playlist export."
          />
        ) : (
          collections.map((collection) => (
            <button
              key={collection.id}
              data-row
              data-selected={
                (selection?.kind === "collection" && selection.id === collection.id) || undefined
              }
              onClick={() => select({ kind: "collection", id: collection.id })}
              className={cn(
                "flex w-full items-start gap-3 rounded-xl p-3 text-left hover:bg-accent/50",
                selection?.kind === "collection" && selection.id === collection.id && "bg-accent",
              )}
            >
              <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted">
                <ListMusic className="size-5 text-muted-foreground" />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="line-clamp-2 text-sm font-medium">{collection.title}</span>
                <SourceLabel source={collection.source} account={collection.account} />
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline">{collection.kind}</Badge>
                  <Badge variant="secondary">{collection.personal ? "Personal" : "Imported"}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {collection.snapshot?.entry_count ?? 0} entries
                  </span>
                </div>
              </div>
            </button>
          ))
        )}
        {query.hasNextPage && (
          <Button
            className="m-3"
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            Load more collections
          </Button>
        )}
      </div>
    </div>
  );
}
function useEntryTitles(entries: CollectionEntry[]) {
  const ids = [...new Set(entries.map((entry) => entry.item_id))];
  const batches: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += LIBRARY_PAGE)
    batches.push(ids.slice(offset, offset + LIBRARY_PAGE));
  const queries = useQueries({
    queries: batches.map((batch) => ({
      queryKey: ["library", "item-summaries", batch],
      queryFn: () => getItemSummaries(batch),
    })),
  });
  return {
    items: new Map(queries.flatMap((query) => query.data ?? []).map((item) => [item.id, item])),
    pending: queries.some((query) => query.isPending),
    error: queries.find((query) => query.isError)?.error,
  };
}
function EntryTitle({ id, item, loading }: { id: string; item?: ItemSummary; loading: boolean }) {
  return (
    <button
      type="button"
      onClick={() => select({ kind: "item", id })}
      className="min-w-0 flex-1 text-left text-sm hover:underline"
    >
      <span className="line-clamp-2">
        {item?.title ?? (loading ? "Loading title…" : `Unavailable item: ${id}`)}
      </span>
      {item && (
        <span className="text-xs text-muted-foreground">
          {item.kind} · {item.source || "Source unknown"}
        </span>
      )}
    </button>
  );
}
function collectionValues(collection: Collection) {
  return {
    title: collection.title,
    description: collection.description,
    entries: (collection.snapshot?.entries ?? [])
      .toSorted((a, b) => a.position - b.position)
      .map((entry) => ({ entry, key: `${entry.position}:${entry.item_id}` })),
  };
}
type EntryRow = ReturnType<typeof collectionValues>["entries"][number];

function CollectionEditor({ collection }: { collection: Collection }) {
  const client = useQueryClient();
  const initial = useMemo(() => collectionValues(collection), [collection]);
  const draft = useDraft("collection", collection.id, initial, collection.revision);
  const { title, description, entries } = draft.value;
  function setEntries(update: (current: EntryRow[]) => EntryRow[]) {
    draft.setValue((current) => ({ ...current, entries: update(current.entries) }));
  }
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [visible, setVisible] = useState(50);
  const [entryStart, setEntryStart] = useState(0);
  const start = Math.min(entryStart, Math.max(0, entries.length - visible));
  const titles = useEntryTitles(entries.slice(start, start + visible).map(({ entry }) => entry));
  const items = useQuery({
    queryKey: ["library", "items", { q: submittedSearch }],
    queryFn: () => getItems({ q: submittedSearch }),
    enabled: submittedSearch.length > 0,
  });
  const mutation = useMutation({
    mutationFn: (submitted: ReturnType<typeof collectionValues>) =>
      saveCollection(collection.id, {
        expected_revision: draft.revision,
        title: submitted.title.trim(),
        description: submitted.description,
        entries: submitted.entries.map(({ entry }, position) => ({ ...entry, position })),
      }),
    onSuccess: async (updated, submitted) => {
      draft.acceptSaved(collectionValues(updated), updated.revision, submitted);
      client.setQueryData<Collection>(["library", "collection", collection.id], (current) =>
        keepLatest(current, updated),
      );
      await client.invalidateQueries({ queryKey: ["library", "collections"] });
      await client.invalidateQueries({ queryKey: ["library", "snapshots", collection.id] });
      await client.invalidateQueries({ queryKey: ["find"] });
    },
    onError: (error) => {
      if (error instanceof RequestError && error.status === 409)
        void client.invalidateQueries({ queryKey: ["library", "collection", collection.id] });
    },
  });
  function move(index: number, direction: number) {
    const next = moveEntry(entries, index, direction, start + visible);
    const nextStart = Math.min(start, Math.max(0, index + direction));
    setEntries(() => next.entries);
    setEntryStart(nextStart);
    setVisible(next.visible - nextStart);
  }
  return (
    <div className="flex flex-col gap-5">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.newer) mutation.mutate(draft.value);
        }}
      >
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="edit-collection-title">Name</FieldLabel>
            <Input
              id="edit-collection-title"
              required
              value={title}
              onChange={(event) =>
                draft.setValue((current) => ({ ...current, title: event.target.value }))
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-collection-description">Description</FieldLabel>
            <Textarea
              id="edit-collection-description"
              value={description}
              onChange={(event) =>
                draft.setValue((current) => ({ ...current, description: event.target.value }))
              }
            />
          </Field>
        </FieldGroup>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">{entries.length} entries</h3>
          <p className="text-xs text-muted-foreground">Repeated items are preserved.</p>
        </div>
        {start > 0 && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Showing entries {start + 1} through {Math.min(start + visible, entries.length)}.
            </p>
            <Button type="button" variant="outline" onClick={() => setEntryStart(0)}>
              Show first entries
            </Button>
          </div>
        )}
        <ol className="flex flex-col gap-2">
          {entries.slice(start, start + visible).map(({ entry, key }, rowIndex) => {
            const index = start + rowIndex;
            return (
              <li key={key} className="flex items-center gap-2 rounded-lg border p-2">
                <span className="w-7 shrink-0 text-center text-xs text-muted-foreground tabular-nums">
                  {index + 1}
                </span>
                <EntryTitle
                  id={entry.item_id}
                  item={titles.items.get(entry.item_id)}
                  loading={titles.pending}
                />
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move entry ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move entry ${index + 1} down`}
                    disabled={index === entries.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove entry ${index + 1}`}
                    onClick={() =>
                      setEntries((current) => current.filter((row) => row.key !== key))
                    }
                  >
                    <X />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
        {titles.error && <ErrorNotice error={titles.error} />}
        {entries.length > start + visible && (
          <Button type="button" variant="outline" onClick={() => setVisible(visible + 50)}>
            Show more entries
          </Button>
        )}
        {mutation.isError && <ErrorNotice error={mutation.error} />}
        {(draft.newer ||
          (draft.dirty &&
            mutation.error instanceof RequestError &&
            mutation.error.status === 409)) && (
          <DraftRecovery
            newer={draft.newer}
            pending={mutation.isPending}
            onReload={() =>
              void client.invalidateQueries({ queryKey: ["library", "collection", collection.id] })
            }
            onReapply={() => {
              draft.reapply();
              mutation.reset();
            }}
            onDiscard={() => {
              draft.reset();
              mutation.reset();
            }}
          >
            <p className="font-medium">{collection.title}</p>
            <p className="whitespace-pre-wrap">{collection.description || "No description"}</p>
            <SnapshotEntries entries={collection.snapshot?.entries ?? []} />
          </DraftRecovery>
        )}
        <div>
          <Button type="submit" disabled={!title.trim() || mutation.isPending || draft.newer}>
            {mutation.isPending ? "Saving…" : "Save collection"}
          </Button>
          {draft.dirty && <p className="mt-2 text-xs text-muted-foreground">Unsaved draft</p>}
        </div>
      </form>
      <Card>
        <CardHeader>
          <CardTitle>Add an item</CardTitle>
          <CardDescription>
            Search your library. Adding the same item again creates another entry.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmittedSearch(search.trim());
            }}
          >
            <Input
              aria-label="Find an item to add"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Title or creator"
            />
            <Button variant="outline" type="submit">
              Find
            </Button>
          </form>
          {items.isFetching && <Spinner />}
          {items.isError && <ErrorNotice error={items.error} />}
          {items.data?.slice(0, 20).map((item) => (
            <Button
              key={item.id}
              type="button"
              variant="outline"
              className="h-auto justify-start whitespace-normal"
              onClick={() => {
                const next = appendEntry(
                  entries,
                  {
                    key: crypto.randomUUID(),
                    entry: {
                      item_id: item.id,
                      position: entries.length,
                      external_id: "",
                      added: { value: new Date().toISOString(), precision: "instant" },
                    },
                  },
                  visible,
                );
                setEntries(() => next.entries);
                setVisible(next.visible);
                setEntryStart(next.start);
              }}
            >
              <Plus data-icon="inline-start" />
              <span className="min-w-0 text-left">
                {item.title}
                <span className="ml-2 text-xs text-muted-foreground">{item.kind}</span>
              </span>
            </Button>
          ))}
          {items.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No matching items. Add the title to your Library first.
            </p>
          )}
          {(items.data?.length ?? 0) > 20 && (
            <p className="text-xs text-muted-foreground">
              Showing the first 20 matches. Narrow the search to find another title.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
function SnapshotEntries({ entries }: { entries: CollectionEntry[] }) {
  const [visible, setVisible] = useState(50);
  const rows = entries.toSorted((a, b) => a.position - b.position).slice(0, visible);
  const titles = useEntryTitles(rows);
  return (
    <>
      <ol className="flex flex-col gap-2">
        {rows.map((entry) => (
          <li key={entry.position} className="flex items-center gap-3 rounded-lg border p-3">
            <span className="w-7 shrink-0 text-xs text-muted-foreground tabular-nums">
              {entry.position + 1}
            </span>
            <EntryTitle
              id={entry.item_id}
              item={titles.items.get(entry.item_id)}
              loading={titles.pending}
            />
          </li>
        ))}
      </ol>
      {titles.error && <ErrorNotice error={titles.error} />}
      {entries.length > visible && (
        <Button type="button" variant="outline" onClick={() => setVisible(visible + 50)}>
          Show more entries
        </Button>
      )}
    </>
  );
}
function HistoricalSnapshot({
  collectionId,
  snapshot,
}: {
  collectionId: string;
  snapshot: SnapshotSummary;
}) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["library", "snapshot", collectionId, snapshot.id],
    queryFn: () => getCollectionSnapshot(collectionId, snapshot.id),
    enabled: open,
  });
  return (
    <details
      className="rounded-lg border p-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {recordedDate(snapshot.captured)} · {snapshot.completeness} · {snapshot.entry_count} entries
      </summary>
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          {query.isPending && <Spinner />}
          {query.isError && <ErrorNotice error={query.error} />}
          {query.data && <SnapshotEntries entries={query.data.entries ?? []} />}
        </div>
      )}
    </details>
  );
}
export function CollectionDetail({ id }: { id: string }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["library", "collection", id],
    queryFn: () => getCollection(id),
  });
  const history = useInfiniteQuery({
    queryKey: ["library", "snapshots", id],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getCollectionSnapshots(id, pageParam),
    getNextPageParam: (last, pages) =>
      last.length === LIBRARY_PAGE ? pages.length * LIBRARY_PAGE : undefined,
    enabled: historyOpen,
  });
  const copy = useMutation({
    mutationFn: (collection: Collection) =>
      createCollection(
        {
          title: `${collection.title} (copy)`,
          kind: collection.kind,
          description: collection.description,
        },
        collection.snapshot?.entries ?? [],
      ),
    onSuccess: async (collection) => {
      await client.invalidateQueries({ queryKey: ["library", "collections"] });
      select({ kind: "collection", id: collection.id });
    },
  });
  if (query.isPending)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  if (query.isError)
    return (
      <div className="p-5">
        <ErrorNotice error={query.error} />
      </div>
    );
  const collection = query.data;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 md:p-7">
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{collection.kind}</Badge>
            <Badge variant="outline">
              {collection.personal ? "Personal" : "Imported snapshot"}
            </Badge>
            <SourceLabel source={collection.source} account={collection.account} />
          </div>
          <h2 className="text-2xl font-semibold break-words">{collection.title}</h2>
          {collection.snapshot && (
            <p className="text-xs text-muted-foreground">
              {recordedDate(collection.snapshot.captured)} · {collection.snapshot.completeness}{" "}
              coverage · {collection.snapshot.entries?.length ?? 0} entries
            </p>
          )}
        </header>
        {collection.personal ? (
          <CollectionEditor key={collection.id} collection={collection} />
        ) : (
          <>
            <p className="text-sm whitespace-pre-wrap text-muted-foreground">
              {collection.description}
            </p>
            <p className="text-sm text-muted-foreground">
              This is a preserved source snapshot. Make a personal copy to edit its name, order or
              entries.
            </p>
            <div>
              <Button
                variant="outline"
                disabled={copy.isPending}
                onClick={() => copy.mutate(collection)}
              >
                <Copy data-icon="inline-start" />
                {copy.isPending ? "Copying…" : "Make editable copy"}
              </Button>
            </div>
            {copy.isError && <ErrorNotice error={copy.error} />}
            <SnapshotEntries
              key={collection.snapshot?.external_id ?? "empty"}
              entries={collection.snapshot?.entries ?? []}
            />
          </>
        )}
        <details
          className="rounded-lg border p-4"
          onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-sm font-medium">Snapshot history</summary>
          <div className="mt-4 flex flex-col gap-3">
            {history.isPending && <Spinner />}
            {history.isError && <ErrorNotice error={history.error} />}
            {historyOpen &&
              history.data?.pages
                .flat()
                .map((snapshot) => (
                  <HistoricalSnapshot key={snapshot.id} collectionId={id} snapshot={snapshot} />
                ))}
            {history.data?.pages[0]?.length === 0 && (
              <p className="text-sm text-muted-foreground">No earlier snapshots are available.</p>
            )}
            {history.hasNextPage && (
              <Button
                type="button"
                variant="outline"
                disabled={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                Load more snapshots
              </Button>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}
