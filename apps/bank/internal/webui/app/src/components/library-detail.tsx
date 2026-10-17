import { Badge } from "@aqt/ui/components/badge";
import { Button } from "@aqt/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@aqt/ui/components/card";
import { Field, FieldGroup, FieldLabel } from "@aqt/ui/components/field";
import { Input } from "@aqt/ui/components/input";
import { Separator } from "@aqt/ui/components/separator";
import { Spinner } from "@aqt/ui/components/spinner";
import { Textarea } from "@aqt/ui/components/textarea";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Film, Heart } from "lucide-react";
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { DraftRecovery } from "@/components/draft-recovery";
import { FilePreview } from "@/components/file-preview";
import {
  Choice,
  ErrorNotice,
  recordedDate,
  safeExternalURL,
  SourceLabel,
  STATUSES,
  UploadFiles,
} from "@/components/library-common";
import { RequestError } from "@/lib/api";
import { keepLatest, useDraft } from "@/lib/draft";
import {
  getActivity,
  getItem,
  getMediaFiles,
  getPage,
  LIBRARY_PAGE,
  saveState,
  type MediaItem,
  type MediaState,
} from "@/lib/library-api";

function trackingValues(state: MediaState) {
  return {
    status: state.status || "unset",
    rating: state.rating === undefined ? "unset" : String(state.rating),
    favorite: state.favorite,
    notes: state.notes,
    tags: (state.tags ?? []).join(", "),
    progress: String(state.progress ?? 0),
    unit: state.progress_unit || "unset",
  };
}
type TrackingValues = ReturnType<typeof trackingValues>;

function StateEditor({ item }: { item: MediaItem }) {
  const client = useQueryClient();
  const initial = useMemo(() => trackingValues(item.state), [item.state]);
  const draft = useDraft("tracking", item.id, initial, item.state.revision);
  const { status, rating, favorite, notes, tags, progress, unit } = draft.value;
  function setField<K extends keyof TrackingValues>(key: K, value: TrackingValues[K]) {
    draft.setValue((current) => ({ ...current, [key]: value }));
  }
  const mutation = useMutation({
    mutationFn: (submitted: TrackingValues) =>
      saveState(item.id, {
        expected_revision: draft.revision,
        status: submitted.status === "unset" ? "" : submitted.status,
        rating: submitted.rating === "unset" ? undefined : Number(submitted.rating),
        favorite: submitted.favorite,
        notes: submitted.notes,
        tags: [
          ...new Set(
            submitted.tags
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean),
          ),
        ],
        progress: submitted.unit === "unset" ? 0 : Number(submitted.progress),
        progress_unit: submitted.unit === "unset" ? "" : submitted.unit,
      }),
    onSuccess: async (state, submitted) => {
      draft.acceptSaved(trackingValues(state), state.revision, submitted);
      client.setQueryData<MediaItem>(["library", "item", item.id], (current) => ({
        ...(current ?? item),
        state: keepLatest(current?.state, state),
      }));
      await client.invalidateQueries({ queryKey: ["library", "items"] });
      await client.invalidateQueries({ queryKey: ["find"] });
    },
    onError: (error) => {
      if (error instanceof RequestError && error.status === 409)
        void client.invalidateQueries({ queryKey: ["library", "item", item.id] });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your tracking</CardTitle>
        <CardDescription>
          These choices are yours. Imported activity does not change them.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.newer) mutation.mutate(draft.value);
          }}
        >
          <FieldGroup className="gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="item-status">Status</FieldLabel>
                <Choice
                  id="item-status"
                  label="Status"
                  value={status}
                  onChange={(value) => setField("status", value)}
                  options={STATUSES}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="item-rating">Rating</FieldLabel>
                <Choice
                  id="item-rating"
                  label="Rating"
                  value={rating}
                  onChange={(value) => setField("rating", value)}
                  options={[
                    { value: "unset", label: "Not rated" },
                    ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} / 5` })),
                  ]}
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="item-progress">Progress</FieldLabel>
                <Input
                  id="item-progress"
                  type="number"
                  min="0"
                  max={unit === "percent" ? 100 : undefined}
                  step="1"
                  disabled={unit === "unset"}
                  value={progress}
                  onChange={(event) => setField("progress", event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="item-progress-unit">Unit</FieldLabel>
                <Choice
                  id="item-progress-unit"
                  label="Progress unit"
                  value={unit}
                  onChange={(value) => setField("unit", value)}
                  options={[
                    { value: "unset", label: "Not recorded" },
                    ...["episodes", "pages", "seconds", "percent"].map((value) => ({
                      value,
                      label: value,
                    })),
                  ]}
                />
              </Field>
            </div>
            <Field orientation="horizontal">
              <input
                id="item-favorite"
                type="checkbox"
                checked={favorite}
                onChange={(event) => setField("favorite", event.target.checked)}
                className="size-4 accent-primary"
              />
              <FieldLabel htmlFor="item-favorite">
                <Heart className="size-4" />
                Favorite
              </FieldLabel>
            </Field>
            <Field>
              <FieldLabel htmlFor="item-tags">Tags</FieldLabel>
              <Input
                id="item-tags"
                value={tags}
                onChange={(event) => setField("tags", event.target.value)}
                placeholder="Separate tags with commas"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="item-notes">Notes</FieldLabel>
              <Textarea
                id="item-notes"
                rows={4}
                value={notes}
                onChange={(event) => setField("notes", event.target.value)}
                placeholder="Your thoughts about this item"
              />
            </Field>
          </FieldGroup>
          {mutation.isError && <ErrorNotice error={mutation.error} />}
          {(draft.newer ||
            (draft.dirty &&
              mutation.error instanceof RequestError &&
              mutation.error.status === 409)) && (
            <DraftRecovery
              newer={draft.newer}
              pending={mutation.isPending}
              onReload={() =>
                void client.invalidateQueries({ queryKey: ["library", "item", item.id] })
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
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-words">
                <dt>Status</dt>
                <dd>
                  {STATUSES.find((option) => option.value === initial.status)?.label ??
                    initial.status}
                </dd>
                <dt>Rating</dt>
                <dd>{initial.rating === "unset" ? "Not rated" : `${initial.rating} / 5`}</dd>
                <dt>Favorite</dt>
                <dd>{initial.favorite ? "Yes" : "No"}</dd>
                <dt>Progress</dt>
                <dd>
                  {initial.unit === "unset"
                    ? "Not recorded"
                    : `${initial.progress} ${initial.unit}`}
                </dd>
                <dt>Tags</dt>
                <dd>{initial.tags || "None"}</dd>
                <dt>Notes</dt>
                <dd className="whitespace-pre-wrap">{initial.notes || "None"}</dd>
              </dl>
            </DraftRecovery>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={mutation.isPending || draft.newer}>
              {mutation.isPending ? "Saving…" : "Save tracking"}
            </Button>
            <span className="text-xs text-muted-foreground">
              Revision {draft.revision}
              {draft.dirty ? " · Unsaved draft" : ""}
            </span>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
function ItemFiles({ id }: { id: string }) {
  const files = useInfiniteQuery({
    queryKey: ["library", "files", { item_id: id }],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getMediaFiles({ item_id: id }, pageParam),
    getNextPageParam: (last, pages) =>
      last.length === LIBRARY_PAGE ? pages.length * LIBRARY_PAGE : undefined,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Files</CardTitle>
        <CardDescription>Original files linked to this item.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <UploadFiles itemId={id} />
        {files.isPending && <Spinner />}
        {files.isError && <ErrorNotice error={files.error} />}
        {files.data?.pages.flat().map((file) => (
          <FilePreview key={file.id} file={file} />
        ))}
        {files.hasNextPage && (
          <Button
            variant="outline"
            disabled={files.isFetchingNextPage}
            onClick={() => void files.fetchNextPage()}
          >
            Load more files
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
function ItemActivity({ id }: { id: string }) {
  const activity = useInfiniteQuery({
    queryKey: ["library", "activity", { item_id: id }],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getActivity({ item_id: id }, pageParam),
    getNextPageParam: (last, pages) =>
      last.length === LIBRARY_PAGE ? pages.length * LIBRARY_PAGE : undefined,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recorded activity</CardTitle>
        <CardDescription>Each row is an observation from its source.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {activity.isPending && <Spinner />}
        {activity.isError && <ErrorNotice error={activity.error} />}
        {activity.data?.pages.flat().map((event) => (
          <div key={event.id} className="flex flex-col gap-1 rounded-lg bg-muted/50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge variant="outline">{event.kind}</Badge>
              <time className="text-xs text-muted-foreground">{recordedDate(event.occurred)}</time>
            </div>
            <SourceLabel source={event.source} account={event.account} />
            {event.provenance.locator && (
              <p className="text-xs break-all text-muted-foreground">{event.provenance.locator}</p>
            )}
          </div>
        ))}
        {activity.data?.pages[0]?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No activity is recorded for this item. Its viewing history is unknown.
          </p>
        )}
        {activity.hasNextPage && (
          <Button
            variant="outline"
            disabled={activity.isFetchingNextPage}
            onClick={() => void activity.fetchNextPage()}
          >
            Load more activity
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
export function ItemDetail({ id }: { id: string }) {
  const query = useQuery({ queryKey: ["library", "item", id], queryFn: () => getItem(id) });
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
  const item = query.data;
  const original = safeExternalURL(item.url);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 md:p-7">
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">
              <Film data-icon="inline-start" />
              {item.kind}
            </Badge>
            {item.year && <Badge variant="outline">{item.year}</Badge>}
            <SourceLabel source={item.source} account={item.account} />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight break-words">{item.title}</h2>
          {item.creators?.length ? (
            <p className="text-sm text-muted-foreground">{item.creators.join(", ")}</p>
          ) : null}
          {item.series && (
            <p className="text-sm text-muted-foreground">
              {item.series}
              {item.season !== undefined ? ` · Season ${item.season}` : ""}
              {item.episode !== undefined ? ` · Episode ${item.episode}` : ""}
            </p>
          )}
          {item.description && (
            <p className="text-sm whitespace-pre-wrap text-muted-foreground">{item.description}</p>
          )}
          {original && (
            <div>
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<a href={original} target="_blank" rel="noreferrer" />}
              >
                <ExternalLink data-icon="inline-start" />
                Open original
              </Button>
            </div>
          )}
        </header>
        <StateEditor key={item.id} item={item} />
        <ItemActivity id={id} />
        <ItemFiles id={id} />
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Source and identity</summary>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 break-all">
            <dt>Item</dt>
            <dd>{item.id}</dd>
            <dt>Source ID</dt>
            <dd>{item.external_id}</dd>
            {item.provider && (
              <>
                <dt>Provider</dt>
                <dd>
                  {item.provider}: {item.provider_id}
                </dd>
              </>
            )}
            {item.provenance.raw_ref && (
              <>
                <dt>Raw input</dt>
                <dd>{item.provenance.raw_ref}</dd>
              </>
            )}
            {item.provenance.locator && (
              <>
                <dt>Location</dt>
                <dd>{item.provenance.locator}</dd>
              </>
            )}
          </dl>
          {(item.evidence?.length ?? 0) > 0 && (
            <div className="mt-4 flex flex-col gap-2">
              <h3 className="font-medium">Retained source references</h3>
              <ul className="flex flex-col gap-2">
                {item.evidence?.map((evidence) => (
                  <li
                    key={JSON.stringify([evidence.raw_ref, evidence.locator])}
                    className="rounded-lg border p-2 break-all"
                  >
                    <p>{evidence.raw_ref}</p>
                    {evidence.locator && <p className="mt-1">{evidence.locator}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </details>
      </div>
    </div>
  );
}
export function PageDetail({ id }: { id: string }) {
  const query = useQuery({ queryKey: ["library", "page", id], queryFn: () => getPage(id) });
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
  const page = query.data;
  return (
    <article className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-5 md:p-8">
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">Published knowledge</Badge>
          <SourceLabel source={page.source} />
        </div>
        <h2 className="text-2xl font-semibold">{page.title}</h2>
        <p className="text-xs break-all text-muted-foreground">{page.path}</p>
        <p className="text-xs text-muted-foreground">
          Published revision: {page.revision || "not recorded"}. This copy is read-only; the
          Markdown source remains authoritative.
        </p>
        <Separator />
        <div className="prose prose-sm max-w-none break-words dark:prose-invert">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{page.body}</ReactMarkdown>
        </div>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Publication details</summary>
          <p className="mt-2 break-all">Content hash: {page.content_hash || "not recorded"}</p>
          <p>Sensitivity: {page.sensitivity || "unclassified"}</p>
        </details>
      </div>
    </article>
  );
}
