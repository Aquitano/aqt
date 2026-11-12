import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { Layout } from "../src/components/Layout";
import { queryKeys } from "../src/queries";

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null }));
afterEach(() => vi.unstubAllGlobals());

const renderShell = async (path: string) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.session, {
    mode: "oidc",
    user: { subject: "thomas", name: "Thomas" },
  });
  const root = createRootRoute({ component: Layout });
  const pages = ["/", "/machines", "/machines/$id"].map((routePath) =>
    createRoute({ getParentRoute: () => root, path: routePath, component: () => <p>Page</p> }),
  );
  const router = createRouter({
    routeTree: root.addChildren(pages),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  client.clear();
  return html;
};

const currentLinks = (html: string) => {
  const navigation = html.slice(
    html.indexOf('aria-label="Main"'),
    html.indexOf('data-slot="sidebar-footer"'),
  );
  return [...navigation.matchAll(/<a\b[^>]*aria-current="page"[^>]*>[\s\S]*?<\/a>/g)].map(
    ([link]) => link.replace(/<[^>]+>/g, ""),
  );
};

test.each([
  ["/", "Overview"],
  ["/machines/00000000-0000-4000-8000-000000000002", "Machines"],
])("only the section for %s is marked as the current page", async (path, label) => {
  expect(currentLinks(await renderShell(path))).toEqual([label]);
});

test("the sidebar toggle is a labelled header button, not a control floating on the sidebar", async () => {
  const html = await renderShell("/");
  const header = html.match(/<header\b[\s\S]*?<\/header>/)?.[0] ?? "";
  expect(header).toMatch(/<button[^>]*aria-label="Collapse sidebar"[^>]*aria-expanded="true"/);
  expect(html.match(/aria-label="(Collapse|Expand) sidebar"/g)).toHaveLength(1);
});
