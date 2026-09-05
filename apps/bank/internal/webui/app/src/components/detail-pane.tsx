import { useQuery } from "@tanstack/react-query";
import { Inbox, ShieldAlert } from "lucide-react";

import { Conversation } from "@/components/conversation";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { getContactMessages, getMessage, getThread } from "@/lib/api";
import { SourceBadge } from "@/lib/format";

// What the right-hand pane is showing. A thread selection carries the id of
// the message that triggered it so the pane can scroll to and highlight it.
export type Selection =
  | { kind: "thread"; source: string; threadId: string; title?: string; flashId?: number }
  | { kind: "message"; id: number }
  | { kind: "contact"; name: string }
  | null;

export function DetailPane({ selection }: { selection: Selection }) {
  const q = useQuery({
    queryKey: ["detail", selection],
    enabled: selection !== null,
    queryFn: async () => {
      if (!selection) return null;
      switch (selection.kind) {
        case "thread": {
          const t = await getThread(selection.source, selection.threadId);
          return {
            title: (
              <span className="flex items-baseline gap-2">
                <SourceBadge source={selection.source} />
                <span className="truncate">{selection.title || selection.threadId}</span>
              </span>
            ),
            meta: `${t.messages.length} messages${t.truncated ? " (truncated)" : ""}`,
            messages: t.messages,
            flashId: selection.flashId ?? null,
          };
        }
        case "message": {
          const m = await getMessage(selection.id);
          return {
            title: (
              <span className="flex items-baseline gap-2">
                <SourceBadge source={m.source} />
                <span className="truncate">{m.subject || m.sender || "—"}</span>
              </span>
            ),
            meta: new Date(m.sent_at).toLocaleDateString("en-GB", { dateStyle: "long" }),
            messages: [m],
            flashId: null,
          };
        }
        case "contact": {
          const msgs = await getContactMessages(selection.name);
          return {
            title: <span>{selection.name}</span>,
            meta: `${msgs.length} messages across sources`,
            messages: [...msgs].reverse(),
            flashId: null,
          };
        }
      }
    },
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
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  if (q.isError)
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
  if (!q.data) return null;
  return (
    <Conversation
      title={q.data.title}
      meta={q.data.meta}
      messages={q.data.messages}
      flashId={q.data.flashId}
    />
  );
}
