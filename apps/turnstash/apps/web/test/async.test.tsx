import { Unauthorized } from "@aqt/turnstash-api";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";

import { Async } from "../src/components/Async";

const renderFailure = async (failure: Error, withData: boolean) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryKey = ["async-retention"];
  if (withData) client.setQueryData(queryKey, { title: "Previously loaded conversation" });
  const observer = new QueryObserver<{ title: string }>(client, {
    queryKey,
    queryFn: () => Promise.reject(failure),
  });
  const result = await observer.refetch();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Async query={result}>{(data) => <p>{data.title}</p>}</Async>
    </QueryClientProvider>,
  );
  observer.destroy();
  client.clear();
  return html;
};

test("a refresh error keeps cached content and offers a retry; an initial failure offers recovery", async () => {
  const refreshed = await renderFailure(new Error("Offline"), true);
  expect(refreshed).toContain("Previously loaded conversation");
  expect(refreshed).toContain("Could not refresh");
  expect(refreshed).toContain(">Retry</button>");
  const initial = await renderFailure(new Error("Offline"), false);
  expect(initial).not.toContain("Previously loaded conversation");
  expect(initial).toContain("Request failed");
  expect(initial).toContain(">Retry</button>");
});

test("expired authorization does not keep archive content visible", async () => {
  const html = await renderFailure(new Unauthorized({ reason: "invalid" }), true);
  expect(html).not.toContain("Previously loaded conversation");
  expect(html).toContain("This archive needs a token");
});
