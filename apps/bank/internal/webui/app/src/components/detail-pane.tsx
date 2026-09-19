import { useInfiniteQuery } from "@tanstack/react-query";
import { Inbox, ShieldAlert } from "lucide-react";

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
import { CONTEXT_PAGE, getContactMessages, getMessage, getThread, type Message } from "@/lib/api";
import { SourceBadge } from "@/lib/format";

export type Selection =
  | { kind: "thread"; source: string; threadId: string; title?: string; flashId?: number }
  | { kind: "message"; id: number }
  | { kind: "contact"; name: string }
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

function SelectedDetail({ selection }: { selection: Selection }) {
  const q = useInfiniteQuery({
    queryKey: ["detail", selection],
    enabled: selection !== null,
    initialPageParam: initialPosition,
    queryFn: async ({ pageParam }): Promise<Page> => {
      if (!selection) return { messages: [], has_before: false, has_after: false };
      switch (selection.kind) {
        case "thread":
          return getThread(
            selection.source,
            selection.threadId,
            pageParam.before || pageParam.after
              ? pageParam
              : selection.flashId
                ? { around: selection.flashId }
                : { latest: true },
          );
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
          <EmptyTitle>Could not load</EmptyTitle>
          <EmptyDescription>{q.error.message}</EmptyDescription>
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
