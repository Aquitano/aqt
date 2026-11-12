import type { BookmarkView } from "@aqt/turnstash-api";
import { Badge } from "@aqt/ui/components/badge";
import { Button } from "@aqt/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aqt/ui/components/empty";
import { Spinner } from "@aqt/ui/components/spinner";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Effect } from "effect";
import {
  BookmarkIcon,
  ListTreeIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { api } from "../api";
import { Async, RequestFailure } from "../components/Async";
import { BookmarkNoteForm } from "../components/BookmarkNoteForm";
import { ConfirmAction } from "../components/ConfirmAction";
import { LoadMore } from "../components/ListControls";
import { MarkdownExportButton } from "../components/MarkdownExportButton";
import { Page, PageHead } from "../components/Page";
import { Section } from "../components/Section";
import { dateTime } from "../format";
import { bookmarkPagesQuery, queryKeys } from "../queries";

const targets = {
  conversation: { label: "Whole conversation", Icon: MessagesSquareIcon },
  message: { label: "Message", Icon: MessageSquareTextIcon },
  turn: { label: "Turn", Icon: ListTreeIcon },
} as const;

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
  const { label, Icon } = targets[target.kind];
  const title = bookmark.conversationTitle ?? "Untitled conversation";
  return (
    <li className="flex min-w-0 gap-3 border-b py-4 first:pt-1 last:border-b-0 last:pb-1">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <article className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Link
            to="/conversations/$id"
            params={{ id: bookmark.conversationId }}
            search={target.kind === "conversation" ? {} : { message: target.messageKey }}
            className="w-fit max-w-full truncate font-medium underline-offset-2 outline-none hover:underline hover:decoration-primary focus-visible:underline"
          >
            {title}
          </Link>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {label}, saved {dateTime(bookmark.createdAt)}
            {!bookmark.available && (
              <Badge variant="warning">This target is no longer available</Badge>
            )}
          </span>
        </div>
        {bookmark.excerpt !== "" && (
          <p className="line-clamp-4 border-l-2 pl-3 wrap-anywhere whitespace-pre-wrap text-muted-foreground">
            {bookmark.excerpt}
          </p>
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
              <p className="rounded-lg bg-muted/60 px-3 py-2 wrap-anywhere whitespace-pre-wrap">
                <span className="sr-only">Note: </span>
                {bookmark.note}
              </p>
            )}
            <div className="flex flex-wrap items-start gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setNote(bookmark.note);
                  setEditing(true);
                }}
              >
                <PencilIcon data-icon="inline-start" />
                {bookmark.note === "" ? "Add note" : "Edit note"}
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
              <ConfirmAction
                trigger={
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive sm:ml-auto"
                  />
                }
                disabled={remove.isPending}
                title={`Delete bookmark for ${title}?`}
                description="This removes the saved bookmark and its note. The conversation stays in your archive."
                actionLabel="Delete bookmark"
                onConfirm={() => remove.mutate()}
              >
                {remove.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Trash2Icon data-icon="inline-start" />
                )}
                Delete bookmark
              </ConfirmAction>
            </div>
          </>
        )}
        {update.isError && <RequestFailure error={update.error} />}
        {remove.isError && <RequestFailure error={remove.error} />}
      </article>
    </li>
  );
};

export const BookmarksPage = () => {
  const pages = useInfiniteQuery(bookmarkPagesQuery());
  const items = pages.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Page>
      <PageHead
        title="Bookmarks"
        note="Conversations, turns and messages you saved, newest first."
      />
      <Async query={pages}>
        {() =>
          items.length === 0 ? (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BookmarkIcon />
                </EmptyMedia>
                <EmptyTitle>No bookmarks yet</EmptyTitle>
                <EmptyDescription>
                  Open a conversation and choose Bookmark on the whole conversation, a turn or a
                  single message. You can add a note to remember why.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={<Link to="/conversations" />}
                >
                  Browse conversations
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <Section
              title="Saved"
              note={`${items.length}${pages.hasNextPage ? "+" : ""} ${items.length === 1 ? "bookmark" : "bookmarks"}`}
            >
              <ul className="flex flex-col">
                {items.map((bookmark) => (
                  <Bookmark key={bookmark.id} bookmark={bookmark} />
                ))}
              </ul>
              {pages.hasNextPage && (
                <LoadMore
                  shown={items.length}
                  noun="bookmarks"
                  loading={pages.isFetching}
                  failed={pages.isFetchNextPageError}
                  onLoad={() => void pages.fetchNextPage()}
                  label="Load more bookmarks"
                />
              )}
            </Section>
          )
        }
      </Async>
    </Page>
  );
};
