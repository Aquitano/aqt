import { Unauthorized } from "@aqt/turnstash-api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { Layout } from "../src/components/Layout";
import { FiltersProvider } from "../src/filters";
import { dashboardSessionQuery, queryKeys, searchQuery } from "../src/queries";
import { BookmarksPage } from "../src/routes/BookmarksPage";
import { ConversationPage } from "../src/routes/ConversationPage";
import { MachinePage } from "../src/routes/MachinePage";
import { OverviewPage } from "../src/routes/OverviewPage";
import { ProjectPage } from "../src/routes/ProjectPage";
import { SearchPage } from "../src/routes/SearchPage";
import { decodeUrlSearch, parseSearchState } from "../src/search-state";

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null }));
afterEach(() => vi.unstubAllGlobals());

const clientOf = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, refetchOnMount: false, staleTime: Infinity },
    },
  });

const fail = (client: QueryClient, key: ReadonlyArray<unknown>, unauthorized: boolean) => {
  const query = client.getQueryCache().find({ queryKey: key });
  if (query === undefined) throw new Error("Missing seeded query");
  query.setState({
    status: "error",
    error: unauthorized ? new Unauthorized({ reason: "invalid" }) : new Error("Offline"),
  });
};

const renderPage = async (
  client: QueryClient,
  component: () => ReactNode,
  path: "/" | "/search" | "/conversations/$id" | "/machines/$id" | "/projects/$key" = "/",
  shell = false,
) => {
  const root = createRootRoute(shell ? { component: Layout } : {});
  const route = createRoute({
    getParentRoute: () => root,
    path,
    component,
    validateSearch: (search) => parseSearchState(decodeUrlSearch(search)),
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({
      initialEntries: [
        {
          "/": "/",
          "/machines/$id": "/machines/00000000-0000-4000-8000-000000000002",
          "/projects/$key": "/projects/private-project",
          "/search": "/search?q=needle&period=all",
          "/conversations/$id": "/conversations/00000000-0000-4000-8000-000000000002",
        }[path],
      ],
    }),
  });
  await router.load();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <FiltersProvider>
        <RouterProvider router={router} />
      </FiltersProvider>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
};

test.each([false, true])(
  "bookmarks and search retain only authorized cached results, unauthorized=%s",
  async (unauthorized) => {
    const bookmarks = clientOf();
    bookmarks.setQueryData(queryKeys.bookmarks, {
      pages: [
        {
          items: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              conversationId: "00000000-0000-4000-8000-000000000002",
              conversationTitle: "Saved private conversation",
              target: { kind: "conversation" },
              note: "Private bookmark note",
              excerpt: "",
              available: false,
              createdAt: "2026-11-05T00:00:00.000Z",
              updatedAt: "2026-11-05T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [null],
    });
    fail(bookmarks, queryKeys.bookmarks, unauthorized);
    const bookmarkHtml = await renderPage(bookmarks, BookmarksPage);
    expect(bookmarkHtml.includes("Private bookmark note")).toBe(!unauthorized);
    expect(bookmarkHtml).toContain(
      unauthorized ? "This archive needs a token" : "Could not refresh",
    );
    if (!unauthorized) expect(bookmarkHtml).toContain(">Retry</button>");

    const search = clientOf();
    const options = searchQuery({ q: "needle", limit: 50 });
    search.setQueryData(options.queryKey, {
      hits: [
        {
          messageId: "message-id",
          messageKey: "message-key",
          seq: 1,
          score: 1,
          conversationId: "00000000-0000-4000-8000-000000000002",
          title: "Private search result",
          projectKey: null,
          provider: "claude",
          role: "user",
          createdAt: "2026-11-05T00:00:00.000Z",
          snippet: "needle",
        },
      ],
    });
    fail(search, options.queryKey, unauthorized);
    const searchHtml = await renderPage(search, SearchPage, "/search");
    expect(searchHtml.includes("Private search result")).toBe(!unauthorized);
    expect(searchHtml).toContain(unauthorized ? "This archive needs a token" : "Could not refresh");
    if (!unauthorized) expect(searchHtml).toContain(">Retry</button>");
  },
);

test.each(["offline", "unauthorized", "signed-out"] as const)(
  "the shell handles a %s session",
  async (state) => {
    const client = clientOf();
    client.setQueryData(queryKeys.session, {
      mode: "oidc",
      user: state === "signed-out" ? null : { subject: "thomas", name: "Thomas" },
    });
    if (state !== "signed-out") fail(client, queryKeys.session, state === "unauthorized");
    const html = await renderPage(client, () => <p>Loaded dashboard content</p>, "/", true);
    expect(html.includes("Loaded dashboard content")).toBe(state === "offline");
    if (state === "offline") {
      expect(html).toContain("Could not refresh");
      expect(html).toContain(">Retry</button>");
      expect(html).toContain("Reload data");
    } else
      expect(html).toContain(
        state === "signed-out" ? "Sign in to Turnstash" : "Your session has expired",
      );
  },
);

test("a denied conversation detail hides cached commits, turn costs and transcript content", async () => {
  const client = clientOf();
  const key = [...queryKeys.conversation, "00000000-0000-4000-8000-000000000002"];
  client.setQueryData(key, {
    commits: [
      {
        repo: "private-repo",
        remote: null,
        sha: "abcdef1234567890",
        subject: "Private commit subject",
        ref: "main",
        onDefaultBranch: true,
        authoredAt: "2026-11-05T00:00:00.000Z",
        costUsd: 12,
      },
    ],
    turns: [0, 1].map((turnIndex) => ({
      turnIndex,
      messageKey: "private-key",
      category: "implementation",
      costUsd: 15,
    })),
  });
  fail(client, key, true);
  const html = await renderPage(client, ConversationPage, "/conversations/$id");
  expect(html).toContain("This archive needs a token");
  expect(html).not.toContain("Private commit subject");
  expect(html).not.toContain("Cost by turn");
  expect(html).not.toContain("Transcript");
});

test.each([401, 403, 503])(
  "session checks classify HTTP %s for appropriate recovery",
  async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    const client = clientOf();
    const result = await client
      .fetchQuery(dashboardSessionQuery())
      .catch((failure: unknown) => failure);
    client.clear();
    expect(result).toBeInstanceOf(Error);
    expect(result instanceof Unauthorized).toBe(status !== 503);
  },
);

test.each([false, true])(
  "overview retains only authorized cached meters, unauthorized=%s",
  async (unauthorized) => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "cb_filters" ? JSON.stringify({ period: "all" }) : null),
    });
    const client = clientOf();
    const key = [...queryKeys.limits, "overview", { from: new Date(0).toISOString() }];
    client.setQueryData(key, {
      generatedAt: "2026-11-05T00:00:00.000Z",
      providers: [
        {
          provider: "claude",
          series: [
            {
              windowMinutes: 300,
              windows: [{ outcome: "open", usedPercent: 30, resetsAt: "2026-11-06T00:00:00.000Z" }],
            },
          ],
          expiredValue: [],
        },
      ],
    });
    fail(client, key, unauthorized);
    const html = await renderPage(client, OverviewPage);
    expect(html.includes("70% left")).toBe(!unauthorized);
    expect(html).toContain(unauthorized ? "This archive needs a token" : "Could not refresh");
    if (!unauthorized) expect(html).toContain(">Retry</button>");
  },
);

test("an initial denied session offers retry without pointing to a hidden token field", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  const client = clientOf();
  await client.fetchQuery(dashboardSessionQuery()).catch(() => undefined);
  const html = await renderPage(client, () => <p>Private dashboard</p>, "/", true);
  expect(html).toContain("Could not check your sign-in");
  expect(html).toContain(">Retry</button>");
  expect(html).not.toContain("Private dashboard");
  expect(html).not.toContain("field in the header");
});

test("denied machine and project requests hide cached header details", async () => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === "cb_filters" ? JSON.stringify({ period: "all" }) : null),
  });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const machine = clientOf();
  const machineKey = [...queryKeys.machine, "00000000-0000-4000-8000-000000000002", null, zone];
  machine.setQueryData(machineKey, {
    machine: { name: "Private workstation", os: "linux", arch: "x64" },
  });
  fail(machine, machineKey, true);
  const machineHtml = await renderPage(machine, MachinePage, "/machines/$id");
  expect(machineHtml).toContain("This archive needs a token");
  expect(machineHtml).not.toContain("Private workstation");
  expect(machineHtml).not.toContain("linux x64");
  const project = clientOf();
  const projectKey = [...queryKeys.project, "private-project", null, zone];
  project.setQueryData(projectKey, { projectPath: "/private/customer-repository" });
  fail(project, projectKey, true);
  const projectHtml = await renderPage(project, ProjectPage, "/projects/$key");
  expect(projectHtml).toContain("This archive needs a token");
  expect(projectHtml).not.toContain("/private/customer-repository");
});
