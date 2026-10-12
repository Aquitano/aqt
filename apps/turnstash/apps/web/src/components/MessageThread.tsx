import type { MessageView, RequestSummary, ToolExecutionView } from "@aqt/turnstash-api";
import { Badge, Button } from "@cloudflare/kumo";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { compact, dateTime, usd } from "../format";
import { messagePagesQuery } from "../queries";
import { Pending, RequestFailure } from "./Async";
import { BookmarkButton } from "./BookmarkButton";
import { Disclosure } from "./Disclosure";
import { SelectForExport, SelectionBar, useExportSelection } from "./ExportSelection";
import { MessagePartView } from "./MessagePartView";
import type { ToolIndex } from "./MessagePartView";

const billedTokens = (request: RequestSummary) =>
  request.inputTokens +
  request.cacheReadTokens +
  request.cacheWriteTokens +
  request.cacheWrite1hTokens +
  request.outputTokens;

const CostChips = ({
  requests,
  onInspect,
}: {
  readonly requests: ReadonlyArray<RequestSummary>;
  readonly onInspect: (requestId: string) => void;
}) => (
  <div className="chips">
    {requests.map((request) => (
      <button key={request.id} type="button" className="chip" onClick={() => onInspect(request.id)}>
        <span>{request.modelId}</span>
        <span>{request.costUsd === null ? "unpriced" : usd(request.costUsd)}</span>
        <span>{compact(billedTokens(request))} tok</span>
      </button>
    ))}
  </div>
);

const parts = (
  message: MessageView,
  tools: ToolIndex,
  query: string | undefined,
  targeted: boolean,
) =>
  message.parts.map((part, index) => (
    <MessagePartView
      key={`${message.id}-${index}`}
      part={part}
      tools={tools}
      query={query}
      targeted={targeted}
    />
  ));

// System prompts repeat the same few thousand words of tool and skill instructions in every
// conversation, so they start collapsed.
const MessageRow = ({
  message,
  tools,
  onInspect,
  conversationId,
  query,
  targeted,
  actions,
}: {
  readonly message: MessageView;
  readonly tools: ToolIndex;
  readonly onInspect: (requestId: string) => void;
  readonly conversationId: string;
  readonly query?: string | undefined;
  readonly targeted: boolean;
  readonly actions: (message: MessageView) => ReactNode;
}) => (
  <article
    className={`message${targeted ? " message-target" : ""}`}
    tabIndex={targeted ? -1 : undefined}
    aria-label={targeted ? "Linked message" : undefined}
  >
    <div className="message-head">
      <span className="message-role">{message.role}</span>
      <span>{dateTime(message.createdAt)}</span>
      <Link
        to="/conversations/$id"
        params={{ id: conversationId }}
        search={{ message: message.messageKey }}
        className="message-link"
        aria-label={`Permalink to ${message.role} message ${message.seq + 1}`}
      >
        Link
      </Link>
      {targeted && <Badge variant="orange">Linked message</Badge>}
      {message.parts.length === 0 && <Badge variant="neutral">empty</Badge>}
      {actions(message)}
    </div>
    {message.role === "system" ? (
      <Disclosure summary="System prompt" defaultOpen={targeted}>
        <div className="part">{parts(message, tools, query, targeted)}</div>
      </Disclosure>
    ) : (
      parts(message, tools, query, targeted)
    )}
    {message.requests.length > 0 && <CostChips requests={message.requests} onInspect={onInspect} />}
  </article>
);

// The transcript scrolls with the page, so the virtualizer needs the list's
// distance from the top of the document. The summary and turns above it load
// separately and push it down, so the distance is re-read whenever the page
// changes size.
const usePageOffset = (ref: RefObject<HTMLElement | null>, layoutReady: boolean) => {
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => setOffset(element.getBoundingClientRect().top + window.scrollY);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [ref, layoutReady]);
  return offset;
};

// The offset is measured on mount, so the list lives below the loading and
// error branches where its element is guaranteed to be rendered.
const VirtualMessages = ({
  messages,
  tools,
  onInspect,
  conversationId,
  messageKey,
  query,
  layoutReady,
  actions,
}: {
  readonly messages: ReadonlyArray<MessageView>;
  readonly tools: ToolIndex;
  readonly onInspect: (requestId: string) => void;
  readonly conversationId: string;
  readonly messageKey?: string | undefined;
  readonly query?: string | undefined;
  readonly layoutReady: boolean;
  readonly actions: (message: MessageView) => ReactNode;
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const sought = useRef(false);
  const focused = useRef(false);
  const scrollMargin = usePageOffset(listRef, layoutReady);
  const getItemKey = useCallback(
    (index: number) => messages[index]?.messageKey ?? index,
    [messages],
  );
  // oxlint-disable-next-line react/incompatible-library -- the compiler leaves this component unmemoized, as TanStack Virtual needs
  const virtualizer = useWindowVirtualizer({
    count: messages.length,
    estimateSize: () => 180,
    overscan: 6,
    getItemKey,
    anchorTo: "end",
    scrollMargin,
  });
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!layoutReady || sought.current || messageKey === undefined || element === null) return;
    if (Math.abs(scrollMargin - element.getBoundingClientRect().top - window.scrollY) > 0.5) return;
    const index = messages.findIndex((message) => message.messageKey === messageKey);
    if (index < 0) return;
    sought.current = true;
    virtualizer.scrollToIndex(index, { align: "start" });
  }, [layoutReady, messageKey, messages, scrollMargin, virtualizer]);
  useLayoutEffect(() => {
    if (!sought.current || focused.current) return;
    const target = listRef.current?.querySelector<HTMLElement>(".message-target");
    if (target === undefined || target === null) return;
    target.focus({ preventScroll: true });
    focused.current = true;
  });

  return (
    <div ref={listRef} className="thread" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const message = messages[item.index];
        if (message === undefined) return null;
        return (
          <div
            key={message.id}
            data-index={item.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${item.start - scrollMargin}px)`,
            }}
          >
            <MessageRow
              message={message}
              tools={tools}
              onInspect={onInspect}
              conversationId={conversationId}
              query={query}
              targeted={message.messageKey === messageKey}
              actions={actions}
            />
          </div>
        );
      })}
    </div>
  );
};

export const MessageThread = ({
  conversationId,
  onInspect,
  messageKey,
  query,
  layoutReady,
}: {
  readonly conversationId: string;
  readonly onInspect: (requestId: string) => void;
  readonly messageKey?: string | undefined;
  readonly query?: string | undefined;
  readonly layoutReady: boolean;
}) => {
  const pages = useInfiniteQuery(messagePagesQuery(conversationId, messageKey));
  const selection = useExportSelection();

  const messages = useMemo(
    () => (pages.data?.pages ?? []).flatMap((page) => page.items),
    [pages.data],
  );
  const tools = useMemo<ToolIndex>(
    () =>
      new Map(
        (pages.data?.pages ?? []).flatMap((page) =>
          page.toolExecutions.map((tool): readonly [string, ToolExecutionView] => [
            tool.toolKey,
            tool,
          ]),
        ),
      ),
    [pages.data],
  );

  if (pages.isPending) return <Pending />;
  if (pages.isError) return <RequestFailure error={pages.error} />;

  return (
    <>
      {pages.hasPreviousPage && (
        <div className="thread-foot">
          <Button
            size="sm"
            loading={pages.isFetchingPreviousPage}
            onClick={() => void pages.fetchPreviousPage()}
          >
            Load earlier messages
          </Button>
        </div>
      )}
      <SelectionBar
        conversationId={conversationId}
        kind="messages"
        selected={selection.selected}
        onClear={selection.clear}
      />
      <VirtualMessages
        messages={messages}
        tools={tools}
        onInspect={onInspect}
        conversationId={conversationId}
        messageKey={messageKey}
        query={query}
        layoutReady={layoutReady}
        actions={(message) => (
          <div className="row">
            <SelectForExport
              label={`Select ${message.role} message ${message.seq + 1} for export`}
              messageKey={message.messageKey}
              selection={selection}
            />
            <BookmarkButton
              conversationId={conversationId}
              target={{ kind: "message", messageKey: message.messageKey }}
            />
          </div>
        )}
      />
      {pages.hasNextPage && (
        <div className="thread-foot">
          <Button
            size="sm"
            loading={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            Load more messages
          </Button>
        </div>
      )}
    </>
  );
};
