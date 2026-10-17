import { Badge } from "@aqt/ui/components/badge";
import { Button } from "@aqt/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@aqt/ui/components/card";
import { Field, FieldGroup, FieldLabel } from "@aqt/ui/components/field";
import { Input } from "@aqt/ui/components/input";
import { Textarea } from "@aqt/ui/components/textarea";
import { cn } from "@aqt/ui/lib/utils";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Film, Heart, Plus, Star } from "lucide-react";
import { useState } from "react";

import {
  Choice,
  ErrorNotice,
  ITEM_KINDS,
  LibraryEmpty,
  LibraryFilters,
  recordedDate,
  SourceLabel,
  STATUSES,
} from "@/components/library-common";
import { createItem, getActivity, getItems, LIBRARY_PAGE, type MediaItem } from "@/lib/library-api";
import { select, useLibraryFilters, type Selection } from "@/lib/navigation";
import { ListSkeleton } from "@/views/search";

export function ItemRow({ item, selected = false }: { item: MediaItem; selected?: boolean }) {
  return (
    <button
      data-row
      data-selected={selected || undefined}
      onClick={() => select({ kind: "item", id: item.id })}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border border-transparent p-3 text-left transition-colors hover:bg-accent/50",
        selected && "border-border bg-accent",
      )}
    >
      <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        {["book", "article"].includes(item.kind) ? (
          <BookOpen className="size-5" />
        ) : (
          <Film className="size-5" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start gap-2">
          <span className="line-clamp-2 text-sm font-medium">{item.title}</span>
          {item.state.favorite && (
            <Heart
              className="size-3.5 shrink-0 fill-current text-muted-foreground"
              aria-label="Favorite"
            />
          )}
        </div>
        <SourceLabel source={item.source} account={item.account} />
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{item.kind}</Badge>
          {item.year && <span className="text-xs text-muted-foreground">{item.year}</span>}
          {item.state.status && (
            <Badge variant="secondary">
              {STATUSES.find((status) => status.value === item.state.status)?.label ??
                item.state.status}
            </Badge>
          )}
          {item.state.rating !== undefined && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Star className="size-3" />
              {item.state.rating}/5
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
function AddItem({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("movie");
  const [url, setURL] = useState("");
  const [description, setDescription] = useState("");
  const mutation = useMutation({
    mutationFn: () => createItem({ title: title.trim(), kind, url: url.trim(), description }),
    onSuccess: async (item) => {
      await client.invalidateQueries({ queryKey: ["library"] });
      select({ kind: "item", id: item.id });
      onClose();
    },
  });
  return (
    <Card className="m-4 mt-0">
      <CardHeader>
        <CardTitle>Add to your library</CardTitle>
        <CardDescription>A title can be saved before you know its dates or rating.</CardDescription>
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
              <FieldLabel htmlFor="new-item-title">Title</FieldLabel>
              <Input
                id="new-item-title"
                required
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-item-kind">Kind</FieldLabel>
              <Choice
                id="new-item-kind"
                label="Kind"
                value={kind}
                onChange={setKind}
                options={ITEM_KINDS.map((value) => ({ value, label: value }))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-item-url">Original link</FieldLabel>
              <Input
                id="new-item-url"
                type="url"
                value={url}
                onChange={(event) => setURL(event.target.value)}
                placeholder="https://"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-item-description">Description</FieldLabel>
              <Textarea
                id="new-item-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
          </FieldGroup>
          {mutation.isError && <ErrorNotice error={mutation.error} />}
          <div className="flex gap-2">
            <Button type="submit" disabled={!title.trim() || mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Add item"}
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
export function LibraryView({ selection }: { selection: Selection }) {
  const [filters, setFilters] = useLibraryFilters("library");
  const [adding, setAdding] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ["library", "items", filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getItems(filters, pageParam),
    getNextPageParam: (last, pages) =>
      last.length === LIBRARY_PAGE ? pages.length * LIBRARY_PAGE : undefined,
  });
  const items = query.data?.pages.flat() ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start justify-between gap-3 p-4">
        <div>
          <h2 className="text-lg font-semibold">Your library</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Media you saved, watched, read or listened to.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setAdding(!adding)}>
          <Plus data-icon="inline-start" />
          Add
        </Button>
      </div>
      <LibraryFilters
        key={JSON.stringify(filters)}
        filters={filters}
        noun="library"
        kinds={ITEM_KINDS}
        onChange={setFilters}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4">
        {adding && <AddItem onClose={() => setAdding(false)} />}
        {query.isPending ? (
          <ListSkeleton />
        ) : query.isError ? (
          <div className="p-3">
            <ErrorNotice error={query.error} />
          </div>
        ) : !items.length ? (
          <LibraryEmpty
            title="No matching items"
            description="Add a title or import a media export. An empty result does not mean you have never seen it."
          />
        ) : (
          <>
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                selected={selection?.kind === "item" && selection.id === item.id}
              />
            ))}
            {query.hasNextPage && (
              <Button
                className="m-3"
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                Load more items
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
export function ActivityView({ selection }: { selection: Selection }) {
  const [filters, setFilters] = useLibraryFilters("activity");
  const query = useInfiniteQuery({
    queryKey: ["library", "activity", filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getActivity(filters, pageParam),
    getNextPageParam: (last, pages) =>
      last.length === LIBRARY_PAGE ? pages.length * LIBRARY_PAGE : undefined,
  });
  const events = query.data?.pages.flat() ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="p-4">
        <h2 className="text-lg font-semibold">Activity</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Recorded activity, with the dates each source actually provides.
        </p>
      </div>
      <LibraryFilters
        key={JSON.stringify(filters)}
        filters={filters}
        noun="activity"
        kinds={["watch", "listen", "read", "play", "view", "purchase", "other"]}
        onChange={setFilters}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {query.isPending ? (
          <ListSkeleton />
        ) : query.isError ? (
          <ErrorNotice error={query.error} />
        ) : !events.length ? (
          <LibraryEmpty
            title="No matching activity"
            description="Import Netflix or YouTube history to see recorded events here. Missing history remains unknown."
          />
        ) : (
          events.map((event) => (
            <button
              key={event.id}
              data-row
              data-selected={
                (selection?.kind === "item" && selection.id === event.item_id) || undefined
              }
              onClick={() => select({ kind: "item", id: event.item_id })}
              className={cn(
                "flex w-full gap-3 rounded-lg p-3 text-left hover:bg-accent/50",
                selection?.kind === "item" && selection.id === event.item_id && "bg-accent",
              )}
            >
              <div className="mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/50" />
              <div className="flex min-w-0 flex-col gap-1.5">
                <time className="text-xs text-muted-foreground">
                  {recordedDate(event.occurred)}
                </time>
                <span className="line-clamp-2 text-sm font-medium">
                  {event.title || "Untitled activity"}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{event.kind}</Badge>
                  <SourceLabel source={event.source} account={event.account} />
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
            Load more activity
          </Button>
        )}
      </div>
    </div>
  );
}
