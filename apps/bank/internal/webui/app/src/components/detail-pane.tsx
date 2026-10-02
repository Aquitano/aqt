import { useInfiniteQuery } from "@tanstack/react-query";
import { Inbox, ShieldAlert } from "lucide-react";
import { useState } from "react";

import { Conversation } from "@/components/conversation";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  CONTEXT_PAGE,
  getContactMessages,
  getMessage,
  getThread,
  getMailConflict,
  MailConflictError,
  type Message,
} from "@/lib/api";
import { SourceBadge } from "@/lib/format";

export type Selection =
  | {
      kind: "thread";
      source: string;
      threadId: string;
      title?: string;
      flashId?: number;
      current?: boolean;
    }
  | { kind: "message"; id: number }
  | { kind: "contact"; name: string }
  | { kind: "mail-conflict"; source: string; key: string }
  | null;

interface Position {
  before?: number;
  after?: number;
}
interface Page {
  messages: Message[];
  has_before: boolean;
  has_after: boolean;
}
const initialPosition: Position = {};

export function DetailPane({ selection }: { selection: Selection }) {
  return <SelectedDetail key={JSON.stringify(selection)} selection={selection} />;
}

function SelectedDetail({ selection: initialSelection }: { selection: Selection }) {
  const [selection, setSelection] = useState(initialSelection);
  const conversationChoices = JSON.stringify(selection) !== JSON.stringify(initialSelection) && (
    <Button variant="outline" size="sm" onClick={() => setSelection(initialSelection)}>
      Back to conversation choices
    </Button>
  );
  const q = useInfiniteQuery({
    queryKey: ["detail", selection],
    enabled: selection !== null,
    initialPageParam: initialPosition,
    queryFn: async ({ pageParam }): Promise<Page> => {
      if (!selection) return { messages: [], has_before: false, has_after: false };
      switch (selection.kind) {
        case "mail-conflict":
          return getMailConflict(selection.source, selection.key, pageParam.before);
        case "thread":
          return getThread(selection.source, selection.threadId, {
            current: selection.current,
            ...(pageParam.before || pageParam.after
              ? pageParam
              : selection.flashId
                ? { around: selection.flashId }
                : { latest: true }),
          });
        case "message":
          return {
            messages: [await getMessage(selection.id)],
            has_before: false,
            has_after: false,
          };
        case "contact": {
          const messages = await getContactMessages(selection.name, pageParam.before);
          return {
            messages: messages.toReversed(),
            has_before: messages.length === CONTEXT_PAGE,
            has_after: false,
          };
        }
      }
      throw new Error("Unknown selection");
    },
    getPreviousPageParam: (first): Position | undefined =>
      first.has_before && first.messages.length ? { before: first.messages[0].id } : undefined,
    getNextPageParam: (last): Position | undefined =>
      last.has_after && last.messages.length
        ? { after: last.messages[last.messages.length - 1].id }
        : undefined,
  });

  if (!selection)
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Inbox />
          </EmptyMedia>
          <EmptyTitle>Nothing selected</EmptyTitle>
          <EmptyDescription>Pick a message or thread from the list</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  if (q.isLoading)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  if (q.isError && !q.data)
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldAlert />
          </EmptyMedia>
          <EmptyTitle>
            {q.error instanceof MailConflictError ? "Conversation split" : "Could not load"}
          </EmptyTitle>
          <EmptyDescription>{q.error.message}</EmptyDescription>
          {conversationChoices}
          {q.error instanceof MailConflictError && (
            <div className="flex flex-wrap gap-2">
              {q.error.conflict.choices.map((threadId) => (
                <Button
                  key={threadId}
                  variant="outline"
                  onClick={() => {
                    if (q.error instanceof MailConflictError)
                      setSelection({
                        kind: "thread",
                        source: q.error.conflict.source,
                        threadId,
                        current: true,
                      });
                  }}
                >
                  {threadId}
                </Button>
              ))}
              <Button
                variant="outline"
                onClick={() => {
                  if (q.error instanceof MailConflictError)
                    setSelection({
                      kind: "mail-conflict",
                      source: q.error.conflict.source,
                      key: q.error.conflict.conflict_key,
                    });
                }}
              >
                Unanchored messages
              </Button>
            </div>
          )}
        </EmptyHeader>
      </Empty>
    );
  const messages = q.data?.pages.flatMap((p) => p.messages) ?? [];
  const first = messages[0];
  const title =
    selection.kind === "contact" ? (
      selection.name
    ) : (
      <span className="flex items-baseline gap-2">
        <SourceBadge
          source={selection.kind === "thread" ? selection.source : (first?.source ?? "")}
        />
        <span className="truncate">
          {selection.kind === "thread"
            ? selection.title || selection.threadId
            : selection.kind === "mail-conflict"
              ? "Unanchored messages"
              : first?.subject || first?.sender || "Message"}
        </span>
      </span>
    );
  return (
    <Conversation
      title={title}
      meta={`${messages.length} messages${q.hasPreviousPage || q.hasNextPage ? " loaded" : ""}`}
      messages={messages}
      flashId={selection.kind === "thread" ? selection.flashId : undefined}
      navigation={
        <>
          {conversationChoices}
          {q.hasPreviousPage && (
            <Button
              variant="outline"
              size="sm"
              disabled={q.isFetching}
              onClick={() => q.fetchPreviousPage()}
            >
              Load earlier
            </Button>
          )}
          {q.hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              disabled={q.isFetching}
              onClick={() => q.fetchNextPage()}
            >
              Load later
            </Button>
          )}
          {q.isFetching && <Spinner className="size-4" />}
          {q.isError && (
            <span role="alert" className="text-xs text-destructive">
              {q.error.message}
            </span>
          )}
        </>
      }
    />
  );
}
