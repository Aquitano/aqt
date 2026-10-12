import type { BookmarkView } from "@aqt/turnstash-api";
import { Button } from "@cloudflare/kumo";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Effect } from "effect";
import { useState } from "react";

import { api } from "../api";
import { Pending, RequestFailure } from "../components/Async";
import { BookmarkNoteForm } from "../components/BookmarkNoteForm";
import { Card } from "../components/Card";
import { MarkdownExportButton } from "../components/MarkdownExportButton";
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
    <article className="bookmark-item">
      <div className="row">
        <Link
          to="/conversations/$id"
          params={{ id: bookmark.conversationId }}
          search={target.kind === "conversation" ? {} : { message: target.messageKey }}
          className="bookmark-title"
        >
          {bookmark.conversationTitle ?? "Untitled conversation"}
        </Link>
        <span className="muted">
          {target.kind} · {dateTime(bookmark.createdAt)}
        </span>
      </div>
      {bookmark.excerpt !== "" && <p className="bookmark-excerpt">{bookmark.excerpt}</p>}
      {!bookmark.available && <p className="muted">This target is no longer available.</p>}
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
          {bookmark.note !== "" && <p className="bookmark-note">{bookmark.note}</p>}
          <div className="row">
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
              loading={remove.isPending}
              onClick={() => remove.mutate()}
            >
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
    <main className="main">
      <div className="page-head">
        <h1 className="page-title">Bookmarks</h1>
        <p className="page-sub">Saved conversations, turns and messages.</p>
      </div>
      <Card title="Saved bookmarks">
        {pages.isPending && <Pending />}
        {pages.isError && <RequestFailure error={pages.error} />}
        {pages.isSuccess && items.length === 0 && (
          <p className="muted">Open a conversation to save a bookmark with an optional note.</p>
        )}
        {items.map((bookmark) => (
          <Bookmark key={bookmark.id} bookmark={bookmark} />
        ))}
        {pages.hasNextPage && (
          <Button
            size="sm"
            loading={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            Load more bookmarks
          </Button>
        )}
      </Card>
    </main>
  );
};
