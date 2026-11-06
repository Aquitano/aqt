import { Unauthorized, type MessagePage } from "@aqt/turnstash-api";
import { InfiniteQueryObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";

import { MessageThread } from "../src/components/MessageThread";
import { messagePagesQuery } from "../src/queries";

const conversationId = "00000000-0000-4000-8000-000000000001";

test.each(["forward", "backward", "refresh", "unauthorized"] as const)(
  "shows appropriate transcript recovery controls after a %s failure",
  async (direction) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnMount: false } },
    });
    const options = messagePagesQuery(conversationId);
    let failRequest = false;
    const page: MessagePage = {
      items: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          messageKey: "loaded-message",
          seq: 1,
          role: "user",
          parentMessageKey: null,
          createdAt: "2026-11-05T00:00:00.000Z",
          parts: [{ type: "text", text: "Already loaded transcript content" }],
          requests: [],
        },
      ],
      toolExecutions: [],
      previousCursor: "earlier",
      nextCursor: "later",
    };
    const observer = new InfiniteQueryObserver(client, {
      ...options,
      queryFn: async () => {
        if (failRequest)
          throw direction === "unauthorized"
            ? new Unauthorized({ reason: "invalid" })
            : new Error("Connection lost");
        return page;
      },
    });
    await observer.refetch();
    failRequest = true;
    const fetchPage = () => {
      if (direction === "forward") return observer.fetchNextPage();
      if (direction === "backward") return observer.fetchPreviousPage();
      return observer.refetch();
    };
    const failed = await fetchPage();
    expect(failed.isError).toBe(true);
    expect(failed.data?.pages[0]?.items).toEqual(page.items);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MessageThread
          conversationId={conversationId}
          turns={[]}
          layoutReady
          onInspect={() => {}}
        />
      </QueryClientProvider>,
    );
    if (direction === "unauthorized") {
      expect(html).toContain("This archive needs a token");
      expect(html).not.toContain("Load earlier messages");
      expect(html).not.toContain("Load more messages");
      expect(html).not.toContain("Retry loading messages");
    } else {
      expect(html).toContain("Could not refresh");
      expect(html).toContain("Showing the last loaded data.");
      expect(html).toContain(
        direction === "backward" ? "Retry loading earlier messages" : "Load earlier messages",
      );
      expect(html).toContain(
        direction === "forward" ? "Retry loading messages" : "Load more messages",
      );
      if (direction === "refresh") expect(html).toContain("Retry refreshing messages");
    }
    failRequest = false;
    const recovered = await fetchPage();
    expect(recovered.isSuccess).toBe(true);
    expect(recovered.data?.pages[0]?.items).toEqual(page.items);
    observer.destroy();
    client.clear();
  },
);
