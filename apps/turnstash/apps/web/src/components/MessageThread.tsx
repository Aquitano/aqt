import type { RequestSummary, TurnView } from "@aqt/turnstash-api";
import { Badge } from "@aqt/ui/components/badge";
import { Bubble, BubbleContent } from "@aqt/ui/components/bubble";
import { Button } from "@aqt/ui/components/button";
import { Message, MessageContent, MessageHeader } from "@aqt/ui/components/message";
import { Spinner } from "@aqt/ui/components/spinner";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { absurd } from "effect/Function";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { compact, dateTime, int, usd } from "../format";
import { messagePagesQuery } from "../queries";
import {
  type Block,
  blockMessageKeys,
  injectedLabel,
  type ToolOutcome,
  toolOutcomes,
  transcriptBlocks,
} from "../transcript";
import { Pending, RequestFailure } from "./Async";
import { BookmarkButton } from "./BookmarkButton";
import { Disclosure } from "./Disclosure";
import { SelectForExport, SelectionBar, useExportSelection } from "./ExportSelection";
import { MessagePartView } from "./MessagePartView";
import { ToolRun } from "./ToolRun";

type Selection = ReturnType<typeof useExportSelection>;

interface Selections {
  readonly messages: Selection;
  readonly turns: Selection;
}

const billedTokens = (request: RequestSummary) =>
  request.inputTokens +
  request.cacheReadTokens +
  request.cacheWriteTokens +
  request.cacheWrite1hTokens +
  request.outputTokens;

const requestLabel = (request: RequestSummary) =>
  `${request.modelId} · ${request.costUsd === null ? "unpriced" : usd(request.costUsd)} · ${compact(billedTokens(request))} tok`;

const quietButton =
  "cursor-pointer rounded-sm text-left underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50";

export const Requests = ({
  requests,
  onInspect,
}: {
  readonly requests: ReadonlyArray<RequestSummary>;
  readonly onInspect: (requestId: string) => void;
}) => {
  const [only, ...rest] = requests;
  if (only === undefined) return null;
  if (rest.length === 0)
    return (
      <button type="button" className={quietButton} onClick={() => onInspect(only.id)}>
        {requestLabel(only)}
      </button>
    );
  const cost = requests.reduce((sum, request) => sum + (request.costUsd ?? 0), 0);
  const unpriced = requests.filter((request) => request.costUsd === null).length;
  return (
    <Disclosure
      summary={`${int(requests.length)} requests · ${usd(cost)}${unpriced > 0 ? ` · ${int(unpriced)} unpriced` : ""}`}
    >
      <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        {requests.map((request) => (
          <li key={request.id}>
            <button type="button" className={quietButton} onClick={() => onInspect(request.id)}>
              {requestLabel(request)}
            </button>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
};

// Every block and tool step carries the same two actions, so they stay out of the way until the
// pointer or focus reaches it, or something is already selected.
const reveal = {
  block: "group-focus-within/block:opacity-100 group-hover/block:opacity-100",
  row: "group-focus-within/row:opacity-100 group-hover/row:opacity-100",
} as const;

const Actions = ({
  group,
  children,
}: {
  readonly group: keyof typeof reveal;
  readonly children: ReactNode;
}) => (
  <div
    className={`flex items-center gap-1 opacity-0 transition-opacity has-data-checked:opacity-100 [@media(hover:none)]:opacity-100 ${reveal[group]}`}
  >
    {children}
  </div>
);

const MessageActions = ({
  group,
  label,
  messageKey,
  conversationId,
  selection,
}: {
  readonly group: keyof typeof reveal;
  readonly label: string;
  readonly messageKey: string;
  readonly conversationId: string;
  readonly selection: Selection;
}) => (
  <Actions group={group}>
    <SelectForExport
      label={`Select ${label} for export`}
      messageKey={messageKey}
      selection={selection}
    />
    <BookmarkButton conversationId={conversationId} target={{ kind: "message", messageKey }} />
  </Actions>
);

// Pasted logs and file dumps make some prompts thousands of lines long; they open on request.
const clampAbove = 1500;

const Clamp = ({
  clamped,
  children,
}: {
  readonly clamped: boolean;
  readonly children: ReactNode;
}) => {
  const [open, setOpen] = useState(!clamped);
  return (
    <>
      <div className={open ? undefined : "max-h-60 overflow-hidden mask-b-from-50%"}>
        {children}
      </div>
      {!open && (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setOpen(true)}>
          Show all
        </Button>
      )}
    </>
  );
};

const TurnHeader = ({
  turn,
  conversationId,
  selection,
}: {
  readonly turn: TurnView;
  readonly conversationId: string;
  readonly selection: Selection;
}) => (
  <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground">
    <span className="font-medium text-foreground">Turn {turn.turnIndex + 1}</span>
    <Badge variant="secondary">{turn.category}</Badge>
    {turn.skill !== null && <span>{turn.skill}</span>}
    {turn.primaryModelId !== null && <span>{turn.primaryModelId}</span>}
    <span>{turn.requests === 1 ? "1 request" : `${int(turn.requests)} requests`}</span>
    {turn.edits > 0 && <span>{turn.edits === 1 ? "1 edit" : `${int(turn.edits)} edits`}</span>}
    <span className="font-medium text-foreground tabular-nums">{usd(turn.costUsd)}</span>
    {turn.messageKey !== null && (
      <div className="ml-auto">
        <Actions group="block">
          <SelectForExport
            label={`Select turn ${turn.turnIndex + 1} for export`}
            messageKey={turn.messageKey}
            selection={selection}
          />
          <BookmarkButton
            conversationId={conversationId}
            target={{ kind: "turn", messageKey: turn.messageKey }}
          />
        </Actions>
      </div>
    )}
  </div>
);

const MessageBlock = ({
  block,
  conversationId,
  query,
  targeted,
  selection,
  onInspect,
}: {
  readonly block: Extract<Block, { kind: "message" }>;
  readonly conversationId: string;
  readonly query: string | undefined;
  readonly targeted: boolean;
  readonly selection: Selection;
  readonly onInspect: (requestId: string) => void;
}) => {
  const { message, parts, requests } = block;
  const rendered = parts.map((part, index) => (
    <MessagePartView
      // oxlint-disable-next-line react/no-array-index-key -- parts have no identity and never reorder
      key={`${block.key}:${index}`}
      part={part}
      markdown={message.role === "assistant"}
      query={query}
      targeted={targeted}
    />
  ));
  const permalink = (
    <Link
      to="/conversations/$id"
      params={{ id: conversationId }}
      search={{ message: message.messageKey }}
      className="underline-offset-2 hover:text-foreground hover:underline"
      aria-label={`Permalink to ${message.role} message ${message.seq + 1}`}
    >
      {dateTime(message.createdAt)}
    </Link>
  );
  const actions = (
    <MessageActions
      group="block"
      label={`${message.role} message ${message.seq + 1}`}
      messageKey={message.messageKey}
      conversationId={conversationId}
      selection={selection}
    />
  );
  const meta =
    "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-normal text-muted-foreground";

  // System messages and injected commands are context, not conversation, so they get one quiet line.
  const collapsed = (summary: string, justify: "justify-start" | "justify-end") => (
    <div className={`flex items-start gap-2 text-xs text-muted-foreground ${justify}`}>
      <Disclosure summary={summary} defaultOpen={targeted}>
        <div className="flex min-w-0 flex-col gap-1.5">{rendered}</div>
      </Disclosure>
      <Requests requests={requests} onInspect={onInspect} />
      {actions}
    </div>
  );

  if (message.role === "system")
    return collapsed(`System message · ${dateTime(message.createdAt)}`, "justify-start");

  if (message.role === "user") {
    const injected = parts.map((part) => (part.type === "text" ? injectedLabel(part.text) : null));
    if (parts.length > 0 && injected.every((label) => label !== null))
      return collapsed(injected.join(" · "), "justify-end");
    const length = parts.reduce(
      (sum, part) => sum + (part.type === "text" ? part.text.length : 0),
      0,
    );
    return (
      <Message align="end">
        <MessageContent>
          <MessageHeader className={`${meta} px-0`}>
            {actions}
            {permalink}
          </MessageHeader>
          <Bubble variant="tinted" align="end" className="max-w-[min(80ch,90%)]">
            <BubbleContent className="flex flex-col gap-2 rounded-2xl">
              <Clamp clamped={!targeted && query === undefined && length > clampAbove}>
                {rendered}
              </Clamp>
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    );
  }

  const [only, ...rest] = requests;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className={meta}>
        {message.role === "tool" && <span className="font-medium text-foreground">Tool</span>}
        {permalink}
        {only !== undefined && rest.length === 0 && (
          <>
            <span aria-hidden>·</span>
            <Requests requests={requests} onInspect={onInspect} />
          </>
        )}
        {actions}
      </div>
      {rendered}
      {rest.length > 0 && <Requests requests={requests} onInspect={onInspect} />}
    </div>
  );
};

interface BlockProps {
  readonly block: Block;
  readonly outcomes: ReadonlyMap<string, ToolOutcome>;
  readonly conversationId: string;
  readonly messageKey: string | undefined;
  readonly query: string | undefined;
  readonly selection: Selections;
  readonly onInspect: (requestId: string) => void;
}

const BlockContent = ({
  block,
  outcomes,
  conversationId,
  messageKey,
  query,
  targeted,
  selection,
  onInspect,
}: BlockProps & { readonly targeted: boolean }) => {
  switch (block.kind) {
    case "turn":
      return (
        <TurnHeader turn={block.turn} conversationId={conversationId} selection={selection.turns} />
      );
    case "message":
      return (
        <MessageBlock
          block={block}
          conversationId={conversationId}
          query={query}
          targeted={targeted}
          selection={selection.messages}
          onInspect={onInspect}
        />
      );
    case "tools":
      return (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <ToolRun
            steps={block.steps}
            outcomes={outcomes}
            query={query}
            targetedKey={messageKey}
            renderActions={(key, label) => (
              <MessageActions
                group="row"
                label={label}
                messageKey={key}
                conversationId={conversationId}
                selection={selection.messages}
              />
            )}
          />
          <div className="pl-2">
            <Requests requests={block.requests} onInspect={onInspect} />
          </div>
        </div>
      );
    default:
      return absurd<ReactNode>(block);
  }
};

const BlockView = ({
  block,
  outcomes,
  conversationId,
  messageKey,
  query,
  selection,
  onInspect,
}: BlockProps) => {
  // A tool run marks its linked step, so a long run is not highlighted as a whole.
  const targeted = block.kind === "message" && block.message.messageKey === messageKey;
  return (
    <article
      className="group/block py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary data-targeted:rounded-md data-targeted:bg-primary/8 data-targeted:px-3 data-targeted:ring-1 data-targeted:ring-primary/40 [&_mark]:rounded-[3px] [&_mark]:bg-primary/30 [&_mark]:px-0.5 [&_mark]:text-foreground"
      data-targeted={targeted ? "" : undefined}
      tabIndex={targeted ? -1 : undefined}
      aria-label={targeted ? "Linked message" : undefined}
    >
      <BlockContent
        block={block}
        outcomes={outcomes}
        conversationId={conversationId}
        messageKey={messageKey}
        query={query}
        targeted={targeted}
        selection={selection}
        onInspect={onInspect}
      />
    </article>
  );
};

// The transcript scrolls with the page, so the virtualizer needs the list's
// distance from the top of the document. The summary above it loads
// separately and pushes it down, so the distance is re-read whenever the page
// changes size.
const usePageOffset = (ref: RefObject<HTMLElement | null>) => {
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const measure = () => setOffset(element.getBoundingClientRect().top + window.scrollY);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [ref]);
  return offset;
};

// The offset is measured on mount, so the list lives below the loading and
// error branches where its element is guaranteed to be rendered.
const VirtualBlocks = ({
  blocks,
  messageKey,
  layoutReady,
  onNearEnd,
  render,
}: {
  readonly blocks: ReadonlyArray<Block>;
  readonly messageKey?: string | undefined;
  readonly layoutReady: boolean;
  readonly onNearEnd: () => void;
  readonly render: (block: Block) => ReactNode;
}) => {
  // The compiler only knows `useVirtualizer` as incompatible; without this it memoizes the
  // rendered items on the virtualizer's identity and the list stops following the scroll.
  "use no memo";
  const listRef = useRef<HTMLDivElement>(null);
  const sought = useRef(false);
  const focused = useRef(false);
  const loadedAt = useRef<number | null>(null);
  const scrollMargin = usePageOffset(listRef);
  const getItemKey = useCallback((index: number) => blocks[index]?.key ?? index, [blocks]);
  // oxlint-disable-next-line react/incompatible-library -- "use no memo" keeps this component unmemoized, as TanStack Virtual needs
  const virtualizer = useWindowVirtualizer({
    count: blocks.length,
    estimateSize: () => 96,
    overscan: 8,
    getItemKey,
    anchorTo: "end",
    scrollMargin,
    // Linked messages land below the sticky page header instead of under it.
    scrollPaddingStart: 64,
  });
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.at(-1)?.index ?? -1;
  // A page that only extends a folded tool run adds no blocks, so loading stops there instead of
  // fetching every remaining page; the Load more button continues it.
  useEffect(() => {
    if (blocks.length === 0 || lastIndex < blocks.length - 6 || loadedAt.current === blocks.length)
      return;
    loadedAt.current = blocks.length;
    onNearEnd();
  }, [blocks.length, lastIndex, onNearEnd]);
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!layoutReady || sought.current || messageKey === undefined || element === null) return;
    if (Math.abs(scrollMargin - element.getBoundingClientRect().top - window.scrollY) > 0.5) return;
    const index = blocks.findIndex((block) => blockMessageKeys(block).includes(messageKey));
    if (index < 0) return;
    sought.current = true;
    virtualizer.scrollToIndex(index, { align: "start" });
  }, [layoutReady, messageKey, blocks, scrollMargin, virtualizer]);
  useLayoutEffect(() => {
    if (!sought.current || focused.current) return;
    const target = listRef.current?.querySelector<HTMLElement>("[data-targeted]");
    if (target === undefined || target === null) return;
    target.focus({ preventScroll: true });
    focused.current = true;
  });

  return (
    <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {items.map((item) => {
        const block = blocks[item.index];
        if (block === undefined) return null;
        return (
          <div
            key={block.key}
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
            {render(block)}
          </div>
        );
      })}
    </div>
  );
};

interface ThreadProps {
  readonly conversationId: string;
  readonly turns: ReadonlyArray<TurnView>;
  readonly onInspect: (requestId: string) => void;
  readonly messageKey?: string | undefined;
  readonly query?: string | undefined;
  readonly layoutReady: boolean;
}

const Thread = ({
  conversationId,
  turns,
  onInspect,
  messageKey,
  query,
  layoutReady,
  selection,
}: ThreadProps & { readonly selection: Selections }) => {
  const pages = useInfiniteQuery(messagePagesQuery(conversationId, messageKey));

  const loaded = useMemo(() => pages.data?.pages ?? [], [pages.data]);
  const blocks = useMemo(
    () =>
      transcriptBlocks(
        loaded.flatMap((page) => page.items),
        turns,
        messageKey,
      ),
    [loaded, turns, messageKey],
  );
  const outcomes = useMemo(
    () =>
      toolOutcomes(
        loaded.flatMap((page) => page.items),
        loaded.flatMap((page) => page.toolExecutions),
      ),
    [loaded],
  );
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = pages;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  if (pages.isPending) return <Pending />;
  if (pages.isError) return <RequestFailure error={pages.error} />;

  return (
    <>
      {pages.hasPreviousPage && (
        <div className="pt-3">
          <Button
            size="sm"
            variant="outline"
            disabled={pages.isFetchingPreviousPage}
            onClick={() => void pages.fetchPreviousPage()}
          >
            {pages.isFetchingPreviousPage && <Spinner data-icon="inline-start" />}
            Load earlier messages
          </Button>
        </div>
      )}
      <VirtualBlocks
        blocks={blocks}
        messageKey={messageKey}
        layoutReady={layoutReady}
        onNearEnd={loadMore}
        render={(block) => (
          <BlockView
            block={block}
            outcomes={outcomes}
            conversationId={conversationId}
            messageKey={messageKey}
            query={query}
            selection={selection}
            onInspect={onInspect}
          />
        )}
      />
      {isFetchingNextPage && <Pending />}
      {hasNextPage && !isFetchingNextPage && (
        <div className="pt-3">
          <Button size="sm" variant="outline" onClick={() => void fetchNextPage()}>
            {isFetchNextPageError ? "Retry loading messages" : "Load more messages"}
          </Button>
        </div>
      )}
    </>
  );
};

// A link to another message remounts the thread around it; the selections live above it so
// they survive that.
export const MessageThread = (props: ThreadProps) => {
  const messageSelection = useExportSelection();
  const turnSelection = useExportSelection();
  return (
    <>
      <div className="sticky top-12 z-10 bg-background empty:hidden">
        <SelectionBar
          conversationId={props.conversationId}
          kind="turns"
          selected={turnSelection.selected}
          onClear={turnSelection.clear}
        />
        <SelectionBar
          conversationId={props.conversationId}
          kind="messages"
          selected={messageSelection.selected}
          onClear={messageSelection.clear}
        />
      </div>
      <Thread
        key={`${props.messageKey ?? ""}:${props.query ?? ""}`}
        {...props}
        selection={{ messages: messageSelection, turns: turnSelection }}
      />
    </>
  );
};
