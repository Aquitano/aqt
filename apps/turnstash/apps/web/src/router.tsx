import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { Layout } from "./components/Layout";
import { AnalysisPage } from "./routes/AnalysisPage";
import { BookmarksPage } from "./routes/BookmarksPage";
import { ConversationPage } from "./routes/ConversationPage";
import { ConversationsPage } from "./routes/ConversationsPage";
import { MachinePage } from "./routes/MachinePage";
import { MachinesPage } from "./routes/MachinesPage";
import { OverviewPage } from "./routes/OverviewPage";
import { ProjectPage } from "./routes/ProjectPage";
import { SearchPage } from "./routes/SearchPage";
import { SettingsPage } from "./routes/SettingsPage";
import { decodeUrlSearch, parseConversationSearch, parseSearchState } from "./search-state";

const rootRoute = createRootRoute({ component: Layout });
const getParentRoute = () => rootRoute;

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute, path: "/", component: OverviewPage }),
  createRoute({ getParentRoute, path: "/analysis", component: AnalysisPage }),
  createRoute({ getParentRoute, path: "/bookmarks", component: BookmarksPage }),
  createRoute({ getParentRoute, path: "/conversations", component: ConversationsPage }),
  createRoute({
    getParentRoute,
    path: "/conversations/$id",
    component: ConversationPage,
    validateSearch: (search) => parseConversationSearch(decodeUrlSearch(search)),
  }),
  createRoute({
    getParentRoute,
    path: "/search",
    component: SearchPage,
    validateSearch: (search) => parseSearchState(decodeUrlSearch(search)),
  }),
  createRoute({ getParentRoute, path: "/machines", component: MachinesPage }),
  createRoute({ getParentRoute, path: "/machines/$id", component: MachinePage }),
  createRoute({ getParentRoute, path: "/projects/$key", component: ProjectPage }),
  createRoute({ getParentRoute, path: "/settings", component: SettingsPage }),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
