import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { QuotaAlerts } from "../src/components/QuotaAlerts";
import { currentLimitsQuery } from "../src/queries";
import { QuotaAlertProvider, useQuotaAlertSettings } from "../src/quota/context";
import { preferencesKey } from "../src/quota/storage";

afterEach(() => vi.unstubAllGlobals());

test("disabled alerts mount without a query or router client", () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  expect(
    renderToStaticMarkup(
      <QuotaAlertProvider>
        <QuotaAlerts />
      </QuotaAlertProvider>,
    ),
  ).toBe("");
});

const CaptureChoose = ({
  capture,
}: {
  readonly capture: (choose: ReturnType<typeof useQuotaAlertSettings>["choose"]) => void;
}) => {
  capture(useQuotaAlertSettings().choose);
  return null;
};

test("granting notification permission preserves settings changed while permission was pending", async () => {
  const stored = new Map([
    [preferencesKey, JSON.stringify({ low: true, unused: false, desktop: false })],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  const captured: { choose?: ReturnType<typeof useQuotaAlertSettings>["choose"] } = {};
  renderToStaticMarkup(
    <QuotaAlertProvider>
      <CaptureChoose
        capture={(choose) => {
          captured.choose = choose;
        }}
      />
    </QuotaAlertProvider>,
  );
  const choose = captured.choose;
  if (choose === undefined) throw new Error("Quota preferences callback was not captured");
  const permissionGranted = Promise.resolve().then(() => choose({ desktop: true }));
  choose({ unused: true });
  await permissionGranted;
  expect(JSON.parse(stored.get(preferencesKey) ?? "null")).toEqual({
    low: true,
    unused: true,
    desktop: true,
  });
});

test("failed quota polling shows monitoring status and a retry control", async () => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) =>
      key === preferencesKey ? JSON.stringify({ low: true, unused: false, desktop: false }) : null,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  await expect(
    client.fetchQuery({
      ...currentLimitsQuery(),
      queryFn: async () => {
        throw new Error("Offline");
      },
    }),
  ).rejects.toThrow("Offline");
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  const html = renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <QueryClientProvider client={client}>
        <QuotaAlertProvider>
          <QuotaAlerts />
        </QuotaAlertProvider>
      </QueryClientProvider>
    </RouterContextProvider>,
  );
  expect(html).toContain("Quota monitoring is unavailable");
  expect(html).toContain(">Retry</button>");
  client.clear();
});
