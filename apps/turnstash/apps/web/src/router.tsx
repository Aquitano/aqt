import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";

import { Pending } from "./components/Async";
import { Layout } from "./components/Layout";
import {
  decodeUrlSearch,
  parseConversationSearch,
  parseConversationListSearch,
  parseLimitsSearch,
  parseSearchState,
} from "./search-state";

const rootRoute = createRootRoute({ component: Layout });
const getParentRoute = () => rootRoute;

const routeTree = rootRoute.addChildren([
  createRoute({
    getParentRoute,
    path: "/",
    component: lazyRouteComponent(() => import("./routes/OverviewPage"), "OverviewPage"),
  }),
  createRoute({
    getParentRoute,
    path: "/limits",
    component: lazyRouteComponent(() => import("./routes/LimitsPage"), "LimitsPage"),
    validateSearch: (search) => parseLimitsSearch(decodeUrlSearch(search)),
  }),
  createRoute({
    getParentRoute,
    path: "/analysis",
    component: lazyRouteComponent(() => import("./routes/AnalysisPage"), "AnalysisPage"),
  }),
  createRoute({
    getParentRoute,
    path: "/bookmarks",
    component: lazyRouteComponent(() => import("./routes/BookmarksPage"), "BookmarksPage"),
  }),
  createRoute({
    getParentRoute,
    path: "/conversations",
    validateSearch: (search) => parseConversationListSearch(decodeUrlSearch(search)),
    component: lazyRouteComponent(() => import("./routes/ConversationsPage"), "ConversationsPage"),
  }),
  createRoute({
    getParentRoute,
    path: "/conversations/$id",
    component: lazyRouteComponent(() => import("./routes/ConversationPage"), "ConversationPage"),
    validateSearch: (search) => parseConversationSearch(decodeUrlSearch(search)),
  }),
  createRoute({
    getParentRoute,
    path: "/search",
    component: lazyRouteComponent(() => import("./routes/SearchPage"), "SearchPage"),
    validateSearch: (search) => parseSearchState(decodeUrlSearch(search)),
  }),
  createRoute({
    getParentRoute,
    path: "/machines",
    component: lazyRouteComponent(() => import("./routes/MachinesPage"), "MachinesPage"),
  }),
  createRoute({
    getParentRoute,
    path: "/machines/$id",
    component: lazyRouteComponent(() => import("./routes/MachinePage"), "MachinePage"),
  }),
  createRoute({
    getParentRoute,
    path: "/projects/$key",
    component: lazyRouteComponent(() => import("./routes/ProjectPage"), "ProjectPage"),
  }),
  createRoute({
    getParentRoute,
    path: "/settings",
    component: lazyRouteComponent(() => import("./routes/SettingsPage"), "SettingsPage"),
  }),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPendingComponent: Pending,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
