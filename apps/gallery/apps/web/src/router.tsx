import { env } from "@aqt/gallery-env/web";
import type { AppRouter } from "@aqt/gallery-server/api/routers/index";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { toast } from "sonner";

import { NotFound, RouteError } from "./components/error-states";
import Loader from "./components/loader";
import { routeTree } from "./routeTree.gen";
import { TRPCProvider } from "./utils/trpc";

export const getRouter = () => {
  const queryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        // Advisory queries (e.g. best-effort lint) opt out: a failure should
        // leave the feature quiet, not raise a retry toast.
        if (query.meta?.suppressErrorToast) return;
        toast.error(error.message, {
          action: {
            label: "retry",
            // Wrap, don't pass `query.invalidate` directly: sonner calls the
            // handler as a bare function, which strips the method's `this` and
            // makes invalidate() throw on `this.state.isInvalidated`.
            onClick: () => query.invalidate(),
          },
        });
      },
    }),
    // Surface a toast when any mutation rejects. Most call sites fire mutations
    // with `void mutate()` and no local catch (e.g. token create/revoke), so
    // without this a failed write would fail silently.
    mutationCache: new MutationCache({
      onError: (error) => toast.error(error.message),
    }),
    // App-wide default: no refetch on window focus. The app drives freshness
    // through explicit invalidation after mutations, not focus, and nothing
    // polls — so the focus refetch only ever cost work. It also hard-guards the
    // museum page, whose 3D world is rebuilt whenever its query data changes
    // identity; a background refetch mid-walk would rebuild the whole scene.
    // (The museum queries also set staleTime:Infinity, belt and suspenders.)
    defaultOptions: {
      queries: { staleTime: 60 * 1000, refetchOnWindowFocus: false },
    },
  });

  const trpcClient = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${env.VITE_SERVER_URL}/trpc`,
        fetch(url, options) {
          return fetch(url, {
            ...options,
            credentials: "include",
          });
        },
      }),
    ],
  });

  const trpc = createTRPCOptionsProxy({
    client: trpcClient,
    queryClient,
  });

  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    context: { trpc, queryClient },
    defaultPendingComponent: () => <Loader />,
    defaultNotFoundComponent: () => <NotFound />,
    defaultErrorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    Wrap: ({ children }) => (
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    ),
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
  });

  return router;
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
