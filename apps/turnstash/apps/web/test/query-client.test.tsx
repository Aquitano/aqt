import { Unauthorized } from "@aqt/turnstash-api";
import { QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";

import { Async } from "../src/components/Async";
import { createQueryClient } from "../src/query-client";

test("denied data stays absent through offline retries and returns only after a successful fetch", async () => {
  const client = createQueryClient();
  const key = ["private-machine"];
  let failure: Error | undefined;
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: async () => {
      if (failure !== undefined) throw failure;
      return { name: "Private workstation" };
    },
  });
  expect((await observer.refetch()).data?.name).toBe("Private workstation");
  failure = new Error("Offline");
  expect((await observer.refetch()).data?.name).toBe("Private workstation");
  failure = new Unauthorized({ reason: "invalid" });
  expect((await observer.refetch()).data).toBeUndefined();
  expect(client.getQueryData(key)).toBeUndefined();
  failure = new Error("Offline after denial");
  const retry = observer.refetch();
  expect(observer.getCurrentResult().data).toBeUndefined();
  const result = await retry;
  expect(result.data).toBeUndefined();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Async query={result}>{(data) => <p>{data.name}</p>}</Async>
    </QueryClientProvider>,
  );
  expect(html).not.toContain("Private workstation");
  expect(html).not.toContain("Showing the last loaded data");
  expect(html).toContain(">Retry</button>");
  failure = undefined;
  expect((await observer.refetch()).data?.name).toBe("Private workstation");
  observer.destroy();
  client.clear();
});
