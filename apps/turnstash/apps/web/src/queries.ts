import type {
  ConversationListQuery,
  MessageQuery,
  SearchQuery,
  StatsFilter,
} from "@aqt/turnstash-api";
import { infiniteQueryOptions, queryOptions, skipToken } from "@tanstack/react-query";
import { Effect, Schema } from "effect";

import { api } from "./api";
import { dateBounds, type DayRange } from "./period";

export const rangeFilter = (range: DayRange | null): StatsFilter =>
  range === null ? {} : dateBounds(range);

// Invalidations reference these so a renamed key cannot silently stop refreshing a screen.
export const queryKeys = {
  session: ["dashboard-session"],
  bookmarks: ["bookmarks"],
  health: ["health"],
  analysis: ["analysis"],
  stats: ["stats"],
  conversationPages: ["conversation-pages"],
  messages: ["messages"],
  conversation: ["conversation"],
  request: ["request"],
  search: ["search"],
  machines: ["machines"],
  projects: ["projects"],
  machine: ["machine"],
  project: ["project"],
  plans: ["plans"],
  catalogs: ["catalogs"],
  rules: ["pricing-rules"],
  unpricedModels: ["unpriced-models"],
  tokens: ["tokens"],
} as const;

const DashboardSession = Schema.Struct({
  mode: Schema.Literals(["oidc", "token"]),
  user: Schema.NullOr(Schema.Struct({ subject: Schema.String, name: Schema.String })),
});

export const dashboardSessionQuery = () =>
  queryOptions({
    queryKey: queryKeys.session,
    queryFn: async () => {
      const response = await fetch("/auth/session", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not check your sign-in. Reload to try again.");
      return Schema.decodeUnknownSync(DashboardSession)(await response.json());
    },
    staleTime: 60_000,
  });

export const healthQuery = () =>
  queryOptions({
    queryKey: queryKeys.health,
    queryFn: () => Effect.runPromise(api.system.health()),
    refetchInterval: (query) => (query.state.data?.repricing == null ? 30_000 : 3_000),
  });

export const analysisQuery = (filter: StatsFilter) =>
  queryOptions({
    queryKey: [...queryKeys.analysis, filter],
    queryFn: () => Effect.runPromise(api.read.analysis({ query: filter })),
  });

export const statsQuery = (filter: StatsFilter) =>
  queryOptions({
    queryKey: [...queryKeys.stats, filter],
    queryFn: () => Effect.runPromise(api.read.stats({ query: filter })),
  });

export const overallQuery = (filter: StatsFilter) =>
  queryOptions({
    queryKey: [...queryKeys.stats, "overall", filter],
    queryFn: () => Effect.runPromise(api.read.statsOverall({ query: filter })),
  });

export const dailyQuery = (filter: StatsFilter) =>
  queryOptions({
    queryKey: [...queryKeys.stats, "daily", filter],
    queryFn: () => Effect.runPromise(api.read.statsDaily({ query: filter })),
  });

// SAFETY: TanStack infers the cursor type from this value, and a plain null would pin it to null.
const firstPage = null as string | null;

export const bookmarkPagesQuery = () =>
  infiniteQueryOptions({
    queryKey: queryKeys.bookmarks,
    queryFn: ({ pageParam }) =>
      Effect.runPromise(
        api.read.listBookmarks({ query: pageParam === null ? {} : { cursor: pageParam } }),
      ),
    initialPageParam: firstPage,
    getNextPageParam: (page) => page.nextCursor,
  });

export const conversationPagesQuery = (query: ConversationListQuery) =>
  infiniteQueryOptions({
    queryKey: [...queryKeys.conversationPages, query],
    queryFn: ({ pageParam }) =>
      Effect.runPromise(
        api.read.listConversations({
          query: pageParam === null ? query : { ...query, cursor: pageParam },
        }),
      ),
    initialPageParam: firstPage,
    getNextPageParam: (page) => page.nextCursor,
  });

type MessagePageParam = Pick<MessageQuery, "message" | "cursor" | "before">;

export const messagePagesQuery = (id: string, message?: string) => {
  const initialPageParam: MessagePageParam = message === undefined ? {} : { message };
  return infiniteQueryOptions({
    queryKey: [...queryKeys.messages, id, message],
    queryFn: ({ pageParam }) =>
      Effect.runPromise(api.read.getMessages({ params: { id }, query: pageParam })),
    initialPageParam,
    getNextPageParam: (page): MessagePageParam | undefined =>
      page.nextCursor === null ? undefined : { cursor: page.nextCursor },
    getPreviousPageParam: (page): MessagePageParam | undefined =>
      page.previousCursor === null ? undefined : { before: page.previousCursor },
  });
};

export const conversationQuery = (id: string) =>
  queryOptions({
    queryKey: [...queryKeys.conversation, id],
    queryFn: () => Effect.runPromise(api.read.getConversation({ params: { id } })),
  });

export const requestQuery = (id: string | null) =>
  queryOptions({
    queryKey: [...queryKeys.request, id],
    queryFn:
      id === null ? skipToken : () => Effect.runPromise(api.read.getRequest({ params: { id } })),
  });

export const searchQuery = (query: SearchQuery) =>
  queryOptions({
    queryKey: [...queryKeys.search, query],
    queryFn: () => Effect.runPromise(api.read.search({ query })),
    enabled: query.q.trim().length > 0,
  });

export const machinesQuery = () =>
  queryOptions({
    queryKey: queryKeys.machines,
    queryFn: () => Effect.runPromise(api.read.listMachines()),
  });

export const projectsQuery = (range: DayRange | null) =>
  queryOptions({
    queryKey: [...queryKeys.projects, range],
    queryFn: () => Effect.runPromise(api.read.listProjects({ query: rangeFilter(range) })),
  });

export const machineQuery = (id: string, range: DayRange | null, timeZone: string) =>
  queryOptions({
    queryKey: [...queryKeys.machine, id, range, timeZone],
    queryFn: () =>
      Effect.runPromise(
        api.read.getMachine({ params: { id }, query: { ...rangeFilter(range), timeZone } }),
      ),
  });

export const projectQuery = (key: string, range: DayRange | null, timeZone: string) =>
  queryOptions({
    queryKey: [...queryKeys.project, key, range, timeZone],
    queryFn: () =>
      Effect.runPromise(
        api.read.getProject({ params: { key }, query: { ...rangeFilter(range), timeZone } }),
      ),
  });

export const plansQuery = () =>
  queryOptions({
    queryKey: queryKeys.plans,
    queryFn: () => Effect.runPromise(api.read.listPlans()),
  });

export const catalogsQuery = () =>
  queryOptions({
    queryKey: queryKeys.catalogs,
    queryFn: () => Effect.runPromise(api.admin.listCatalogs()),
    refetchInterval: (query) =>
      query.state.data?.some((catalog) => catalog.pending) ? 3_000 : false,
  });
export const rulesQuery = () =>
  queryOptions({
    queryKey: queryKeys.rules,
    queryFn: () => Effect.runPromise(api.admin.listRules()),
  });
export const unpricedModelsQuery = () =>
  queryOptions({
    queryKey: queryKeys.unpricedModels,
    queryFn: () => Effect.runPromise(api.admin.listUnpricedModels()),
  });

export const tokensQuery = () =>
  queryOptions({
    queryKey: queryKeys.tokens,
    queryFn: () => Effect.runPromise(api.admin.listTokens()),
  });
