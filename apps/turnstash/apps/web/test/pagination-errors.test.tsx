import { Unauthorized } from "@aqt/turnstash-api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";

import { MessageThread } from "../src/components/MessageThread";
import { messagePagesQuery } from "../src/queries";

const conversationId = "00000000-0000-4000-8000-000000000001";

test.each(["forward", "backward", "refresh", "unauthorized"] as const)(
  "shows appropriate transcript recovery controls after a %s failure",
  (direction) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnMount: false } },
    });
    const options = messagePagesQuery(conversationId);
    client.setQueryData(options.queryKey, {
      pages: [{ items: [], toolExecutions: [], previousCursor: "earlier", nextCursor: "later" }],
      pageParams: [{}],
    });
    const query = client.getQueryCache().find({ queryKey: options.queryKey });
    if (query === undefined) throw new Error("Missing seeded query");
    query.setState({
      status: "error",
      error:
        direction === "unauthorized"
          ? new Unauthorized({ reason: "invalid" })
          : new Error("Connection lost"),
      fetchMeta:
        direction === "refresh" || direction === "unauthorized"
          ? null
          : { fetchMore: { direction } },
    });
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
    client.clear();
  },
);
