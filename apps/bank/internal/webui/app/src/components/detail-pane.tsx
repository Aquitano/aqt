import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Inbox, ShieldAlert } from "lucide-react";

import { ContactEditor } from "@/components/contact-editor";
import { Conversation } from "@/components/conversation";
import { FileDetail } from "@/components/file-preview";
import { ItemDetail, PageDetail } from "@/components/library-detail";
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
import { navigate, select, useLocation, type Selection } from "@/lib/navigation";
import { CollectionDetail } from "@/views/collections";
export type { Selection } from "@/lib/navigation";

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
  if (selection?.kind === "item") return <ItemDetail key={selection.id} id={selection.id} />;
  if (selection?.kind === "collection")
    return <CollectionDetail key={selection.id} id={selection.id} />;
  if (selection?.kind === "page") return <PageDetail key={selection.id} id={selection.id} />;
  if (selection?.kind === "file")
    return <FileDetail key={selection.file.sha256} file={selection.file} />;
  if (selection?.kind === "message") return <LinkedMessage key={selection.id} id={selection.id} />;
  if (selection?.kind === "contact")
    return (
      <div key={selection.name} className="flex h-full min-h-0 flex-col">
        <ContactEditor name={selection.name} />
        <div className="min-h-0 flex-1">
          <SelectedDetail selection={selection} />
        </div>
      </div>
    );
  return <SelectedDetail key={JSON.stringify(selection)} selection={selection} />;
}

function LinkedMessage({ id }: { id: number | string }) {
  const message = useQuery({ queryKey: ["message", id], queryFn: () => getMessage(id) });
  if (message.isPending)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  if (message.isError)
    return (
      <p role="alert" className="p-6 text-destructive">
        {message.error.message}
      </p>
    );
  const m = message.data;
  return (
    <SelectedDetail
      selection={
        m.thread_id
          ? {
              kind: "thread",
              source: m.source,
              threadId: m.thread_id,
              title: m.subject,
              flashId: m.id,
              current: true,
            }
          : { kind: "message", id: m.id }
      }
      message={m}
    />
  );
}

type ConversationSelection = Exclude<Selection, { kind: "item" | "collection" | "page" }>;
function SelectedDetail({
  selection,
  message,
}: {
  selection: ConversationSelection;
  message?: Message;
}) {
  const location = useLocation();
  const choices = new URLSearchParams(location).get("choices");
  const conversationChoices = choices && (
    <Button
      variant="outline"
      size="sm"
      onClick={() =>
        navigate((params) => {
          Array.from(params.keys()).forEach((key) => params.delete(key));
          new URLSearchParams(choices).forEach((value, key) => params.append(key, value));
        })
      }
    >
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
            messages: [message ?? (await getMessage(selection.id))],
            has_before: false,
            has_after: false,
          };
        case "file":
          return { messages: [], has_before: false, has_after: false };
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
          <EmptyDescription>Select an item to see its details</EmptyDescription>
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
                      select(
                        {
                          kind: "thread",
                          source: q.error.conflict.source,
                          threadId,
                          current: true,
                        },
                        choices || location,
                      );
                  }}
                >
                  {threadId}
                </Button>
              ))}
              <Button
                variant="outline"
                onClick={() => {
                  if (q.error instanceof MailConflictError)
                    select(
                      {
                        kind: "mail-conflict",
                        source: q.error.conflict.source,
                        key: q.error.conflict.conflict_key,
                      },
                      choices || location,
                    );
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
            ? selection.title || first?.subject || selection.threadId
            : selection.kind === "mail-conflict"
              ? "Unanchored messages"
              : first?.subject || first?.sender || "Message"}
        </span>
      </span>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
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
      </div>
    </div>
  );
}
