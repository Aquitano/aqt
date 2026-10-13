import type { BookmarkView } from "@aqt/turnstash-api";
import { Button } from "@aqt/ui/components/button";
import { Spinner } from "@aqt/ui/components/spinner";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Effect } from "effect";
import { useState } from "react";

import { api } from "../api";
import { Pending, RequestFailure } from "../components/Async";
import { BookmarkNoteForm } from "../components/BookmarkNoteForm";
import { MarkdownExportButton } from "../components/MarkdownExportButton";
import { Page, PageHead } from "../components/Page";
import { Section } from "../components/Section";
import { dateTime } from "../format";
import { bookmarkPagesQuery, queryKeys } from "../queries";

const Bookmark = ({ bookmark }: { readonly bookmark: BookmarkView }) => {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(bookmark.note);
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks });
  };
  const update = useMutation({
    mutationFn: () =>
      Effect.runPromise(
        api.admin.updateBookmark({ params: { id: bookmark.id }, payload: { note } }),
      ),
    onSuccess: () => {
      setEditing(false);
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () => Effect.runPromise(api.admin.deleteBookmark({ params: { id: bookmark.id } })),
    onSuccess: invalidate,
  });
  const target = bookmark.target;
  return (
    <article className="flex flex-col gap-2 border-b py-4 text-sm last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/conversations/$id"
          params={{ id: bookmark.conversationId }}
          search={target.kind === "conversation" ? {} : { message: target.messageKey }}
          className="font-semibold underline-offset-2 outline-none hover:underline hover:decoration-flame focus-visible:underline"
        >
          {bookmark.conversationTitle ?? "Untitled conversation"}
        </Link>
        <span className="text-xs text-muted-foreground">
          {target.kind} · {dateTime(bookmark.createdAt)}
        </span>
      </div>
      {bookmark.excerpt !== "" && (
        <p className="wrap-anywhere whitespace-pre-wrap text-muted-foreground">
          {bookmark.excerpt}
        </p>
      )}
      {!bookmark.available && (
        <p className="text-xs text-muted-foreground">This target is no longer available.</p>
      )}
      {editing ? (
        <BookmarkNoteForm
          note={note}
          onNoteChange={setNote}
          onSubmit={() => update.mutate()}
          onCancel={() => setEditing(false)}
          pending={update.isPending}
          submitLabel="Save note"
        />
      ) : (
        <>
          {bookmark.note !== "" && (
            <p className="wrap-anywhere whitespace-pre-wrap">{bookmark.note}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setNote(bookmark.note);
                setEditing(true);
              }}
            >
              Edit note
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending && <Spinner data-icon="inline-start" />}
              Delete bookmark
            </Button>
            {bookmark.available && (
              <MarkdownExportButton
                conversationId={bookmark.conversationId}
                selection={
                  target.kind === "conversation"
                    ? { kind: "conversation" }
                    : {
                        kind: target.kind === "turn" ? "turns" : "messages",
                        messageKeys: [target.messageKey],
                      }
                }
              />
            )}
          </div>
        </>
      )}
      {update.isError && <RequestFailure error={update.error} />}
      {remove.isError && <RequestFailure error={remove.error} />}
    </article>
  );
};

export const BookmarksPage = () => {
  const pages = useInfiniteQuery(bookmarkPagesQuery());
  const items = pages.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Page>
      <PageHead title="Bookmarks" note="Saved conversations, turns and messages." />
      <Section title="Saved bookmarks">
        {pages.isPending && <Pending />}
        {pages.isError && <RequestFailure error={pages.error} />}
        {pages.isSuccess && items.length === 0 && (
          <p className="py-2 text-xs text-muted-foreground">
            Open a conversation to save a bookmark with an optional note.
          </p>
        )}
        {items.map((bookmark) => (
          <Bookmark key={bookmark.id} bookmark={bookmark} />
        ))}
        {pages.hasNextPage && (
          <Button
            size="sm"
            variant="outline"
            disabled={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            {pages.isFetchingNextPage && <Spinner data-icon="inline-start" />}
            Load more bookmarks
          </Button>
        )}
      </Section>
    </Page>
  );
};
