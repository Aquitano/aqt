import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Copy, ListMusic, Plus, X } from "lucide-react";
import { useState } from "react";

import {
  Choice,
  ErrorNotice,
  LibraryEmpty,
  LibraryFilters,
  recordedDate,
  SourceLabel,
} from "@/components/library-common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { RequestError } from "@/lib/api";
import {
  createCollection,
  getCollection,
  getCollections,
  getCollectionSnapshots,
  getItem,
  getItems,
  LIBRARY_PAGE,
  saveCollection,
  type Collection,
  type CollectionEntry,
  type LibraryFilters as Filters,
} from "@/lib/library-api";
import { select, type Selection } from "@/lib/navigation";
import { cn } from "@/lib/utils";
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
            <Button disabled={!title.trim() || mutation.isPending}>
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
  const [filters, setFilters] = useState<Filters>({});
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
      <LibraryFilters noun="collections" kinds={KINDS} onChange={setFilters} />
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
                    {collection.snapshot?.entries?.length ?? 0} entries
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
function EntryTitle({ id }: { id: string }) {
  const item = useQuery({ queryKey: ["library", "item", id], queryFn: () => getItem(id) });
  return (
    <button
      type="button"
      onClick={() => select({ kind: "item", id })}
      className="min-w-0 flex-1 text-left text-sm hover:underline"
    >
      <span className="line-clamp-2">
        {item.data?.title ?? (item.isError ? `Unavailable item: ${id}` : "Loading title…")}
      </span>
      {item.data && (
        <span className="text-xs text-muted-foreground">
          {item.data.kind} · {item.data.source || "Source unknown"}
        </span>
      )}
    </button>
  );
}
function CollectionEditor({ collection }: { collection: Collection }) {
  const client = useQueryClient();
  const [title, setTitle] = useState(collection.title);
  const [description, setDescription] = useState(collection.description);
  const [entries, setEntries] = useState(() =>
    (collection.snapshot?.entries ?? [])
      .toSorted((a, b) => a.position - b.position)
      .map((entry) => ({ entry, key: crypto.randomUUID() })),
  );
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [visible, setVisible] = useState(50);
  const items = useQuery({
    queryKey: ["library", "items", { q: submittedSearch }],
    queryFn: () => getItems({ q: submittedSearch }),
    enabled: submittedSearch.length > 0,
  });
  const mutation = useMutation({
    mutationFn: () =>
      saveCollection(collection.id, {
        expected_revision: collection.revision,
        title: title.trim(),
        description,
        entries: entries.map(({ entry }, position) => ({ ...entry, position })),
      }),
    onSuccess: async (updated) => {
      client.setQueryData(["library", "collection", collection.id], updated);
      await client.invalidateQueries({ queryKey: ["library", "collections"] });
      await client.invalidateQueries({ queryKey: ["library", "snapshots", collection.id] });
      await client.invalidateQueries({ queryKey: ["find"] });
    },
  });
  function move(index: number, direction: number) {
    setEntries((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }
  return (
    <div className="flex flex-col gap-5">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="edit-collection-title">Name</FieldLabel>
            <Input
              id="edit-collection-title"
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-collection-description">Description</FieldLabel>
            <Textarea
              id="edit-collection-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </FieldGroup>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">{entries.length} entries</h3>
          <p className="text-xs text-muted-foreground">Repeated items are preserved.</p>
        </div>
        <ol className="flex flex-col gap-2">
          {entries.slice(0, visible).map(({ entry, key }, index) => (
            <li key={key} className="flex items-center gap-2 rounded-lg border p-2">
              <span className="w-7 shrink-0 text-center text-xs text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <EntryTitle id={entry.item_id} />
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
                  onClick={() => setEntries((current) => current.filter((row) => row.key !== key))}
                >
                  <X />
                </Button>
              </div>
            </li>
          ))}
        </ol>
        {entries.length > visible && (
          <Button type="button" variant="outline" onClick={() => setVisible(visible + 50)}>
            Show more entries
          </Button>
        )}
        {mutation.isError && (
          <ErrorNotice error={mutation.error}>
            {mutation.error instanceof RequestError && mutation.error.status === 409 && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void client.invalidateQueries({
                    queryKey: ["library", "collection", collection.id],
                  })
                }
              >
                Discard draft and reload current collection
              </Button>
            )}
          </ErrorNotice>
        )}
        <div>
          <Button disabled={!title.trim() || mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save collection"}
          </Button>
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
              onClick={() =>
                setEntries((current) => [
                  ...current,
                  {
                    key: crypto.randomUUID(),
                    entry: {
                      item_id: item.id,
                      position: current.length,
                      external_id: "",
                      added: { value: new Date().toISOString(), precision: "instant" },
                    },
                  },
                ])
              }
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
  return (
    <>
      <ol className="flex flex-col gap-2">
        {entries
          .toSorted((a, b) => a.position - b.position)
          .slice(0, visible)
          .map((entry) => (
            <li key={entry.position} className="flex items-center gap-3 rounded-lg border p-3">
              <span className="w-7 shrink-0 text-xs text-muted-foreground tabular-nums">
                {entry.position + 1}
              </span>
              <EntryTitle id={entry.item_id} />
            </li>
          ))}
      </ol>
      {entries.length > visible && (
        <Button variant="outline" onClick={() => setVisible(visible + 50)}>
          Show more entries
        </Button>
      )}
    </>
  );
}
function HistoricalSnapshot({
  snapshot,
}: {
  snapshot: Awaited<ReturnType<typeof getCollectionSnapshots>>[number];
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="rounded-lg border p-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {recordedDate(snapshot.captured)} · {snapshot.completeness} ·{" "}
        {snapshot.entries?.length ?? 0} entries
      </summary>
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <SnapshotEntries entries={snapshot.entries ?? []} />
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
  const history = useQuery({
    queryKey: ["library", "snapshots", id],
    queryFn: () => getCollectionSnapshots(id),
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
          <CollectionEditor
            key={`${collection.id}:${collection.revision}`}
            collection={collection}
          />
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
              history.data?.map((snapshot) => (
                <HistoricalSnapshot key={snapshot.external_id} snapshot={snapshot} />
              ))}
            {history.data?.length === 0 && (
              <p className="text-sm text-muted-foreground">No earlier snapshots are available.</p>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}
