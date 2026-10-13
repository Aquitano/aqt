import {
  CommitBatch,
  CommitBatchResult,
  EnrollRequest,
  EnrollResponse,
  IngestBatch,
  IngestResult,
  IsoDate,
  MachineId,
  RepositoryTask,
  Tombstone,
} from "@aqt/turnstash-core";
import { Schema } from "effect";
import { Context } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/http-api";

import {
  Analysis,
  BookmarkInput,
  BookmarkNote,
  BookmarkPage,
  BookmarkView,
  MarkdownExport,
  MarkdownExportInput,
  ApiTokenCreated,
  ApiTokenView,
  ConversationDetail,
  ConversationListQuery,
  ConversationPage,
  Health,
  Iso,
  MachineDetail,
  MachineSummary,
  MessagePage,
  MessageQuery,
  NulFreeString,
  Overall,
  PageLimit,
  PricingCatalogView,
  PricingRuleInput,
  PricingRuleView,
  ProjectDetail,
  ProjectRow,
  RequestDetail,
  SearchQuery,
  SearchResult,
  Stats,
  StatsDaily,
  StatsFilter,
  SubscriptionPlan,
  SubscriptionPlanChange,
  SubscriptionPlanInput,
  SubscriptionPlanPatch,
  TokenScope,
  TimelineCursor,
  TimelineVersion,
  TimelinePage,
  UnpricedModelRow,
  Uuid,
} from "./schemas.ts";

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { reason: Schema.Literals(["missing", "invalid", "scope"]) },
  { httpApiStatus: 401 },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { entity: Schema.String, id: Schema.String },
  { httpApiStatus: 404 },
) {}

export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class TimelineChanged extends Schema.TaggedError<TimelineChanged>()(
  "TimelineChanged",
  { expectedVersion: TimelineVersion, actualVersion: TimelineVersion, message: Schema.String },
  { httpApiStatus: 409 },
) {}

// Two periods of one provider on the same day would count that day's plan cost twice.
export class PlanOverlap extends Schema.TaggedError<PlanOverlap>()(
  "PlanOverlap",
  { existing: SubscriptionPlan },
  { httpApiStatus: 409 },
) {}

export class PlanEndsBeforeStart extends Schema.TaggedError<PlanEndsBeforeStart>()(
  "PlanEndsBeforeStart",
  { startedOn: IsoDate, endedOn: IsoDate },
  { httpApiStatus: 400 },
) {}

export type Actor =
  | { readonly kind: "admin" }
  | { readonly kind: "machine"; readonly machineId: MachineId }
  | {
      readonly kind: "token";
      readonly tokenId: string;
      readonly scopes: ReadonlyArray<TokenScope>;
    };

export class CurrentActor extends Context.Service<CurrentActor, Actor>()(
  "@turnstash/CurrentActor",
) {}

export const dashboardCookie = "__Host-turnstash-session";
const dashboardSecurity = {
  bearer: HttpApiSecurity.bearer,
  session: HttpApiSecurity.apiKey({ key: dashboardCookie, in: "cookie" }),
};

export class AdminAuth extends HttpApiMiddleware.Service<AdminAuth, { provides: CurrentActor }>()(
  "@turnstash/AdminAuth",
  { security: dashboardSecurity, error: Unauthorized },
) {}

export class ReadAuth extends HttpApiMiddleware.Service<ReadAuth, { provides: CurrentActor }>()(
  "@turnstash/ReadAuth",
  { security: dashboardSecurity, error: Unauthorized },
) {}

export class MachineAuth extends HttpApiMiddleware.Service<
  MachineAuth,
  { provides: CurrentActor }
>()("@turnstash/MachineAuth", {
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized,
}) {}

const RangeQuery = {
  from: StatsFilter.fields.from,
  to: StatsFilter.fields.to,
  timeZone: StatsFilter.fields.timeZone,
};

export const health = HttpApiEndpoint.get("health", "/health", { success: Health });

export const ingestGroup = HttpApiGroup.make("ingest")
  .add(
    HttpApiEndpoint.post("pushBatch", "/batches", {
      payload: IngestBatch,
      success: IngestResult,
      error: BadRequest,
    }),
  )
  .add(
    HttpApiEndpoint.get("tombstones", "/tombstones", {
      query: { since: Schema.optionalKey(Iso) },
      success: Schema.Array(Tombstone),
    }),
  )
  .add(
    HttpApiEndpoint.get("repositories", "/repositories", {
      success: Schema.Array(RepositoryTask),
      error: BadRequest,
    }),
  )
  .add(
    HttpApiEndpoint.post("pushCommits", "/commits", {
      payload: CommitBatch,
      success: CommitBatchResult,
      error: BadRequest,
    }),
  )
  .prefix("/ingest")
  .middleware(MachineAuth);

export const readGroup = HttpApiGroup.make("read")
  .add(
    HttpApiEndpoint.get("listBookmarks", "/bookmarks", {
      query: {
        conversationId: Schema.optionalKey(Uuid),
        cursor: Schema.optionalKey(Uuid),
        limit: Schema.optionalKey(PageLimit),
      },
      success: BookmarkPage,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("exportMarkdown", "/conversations/:id/export", {
      params: { id: Uuid },
      payload: MarkdownExportInput,
      success: MarkdownExport,
      error: [NotFound, BadRequest],
    }),
  )
  .add(HttpApiEndpoint.get("stats", "/stats", { query: StatsFilter, success: Stats }))
  .add(
    HttpApiEndpoint.get("statsOverall", "/stats/overall", { query: StatsFilter, success: Overall }),
  )
  .add(
    HttpApiEndpoint.get("statsDaily", "/stats/daily", { query: StatsFilter, success: StatsDaily }),
  )
  .add(HttpApiEndpoint.get("analysis", "/analysis", { query: StatsFilter, success: Analysis }))
  .add(
    HttpApiEndpoint.get("listConversations", "/conversations", {
      query: ConversationListQuery,
      success: ConversationPage,
    }),
  )
  .add(
    HttpApiEndpoint.get("getConversation", "/conversations/:id", {
      params: { id: Uuid },
      success: ConversationDetail,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("getMessages", "/conversations/:id/messages", {
      params: { id: Uuid },
      query: MessageQuery,
      success: MessagePage,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("getTimeline", "/conversations/:id/timeline", {
      params: { id: Uuid },
      query: {
        cursor: Schema.optionalKey(TimelineCursor),
        limit: Schema.optionalKey(PageLimit),
        expectedVersion: Schema.optionalKey(TimelineVersion),
      },
      success: TimelinePage,
      error: [NotFound, BadRequest, TimelineChanged],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRequest", "/requests/:id", {
      params: { id: Uuid },
      success: RequestDetail,
      error: NotFound,
    }),
  )
  .add(HttpApiEndpoint.get("search", "/search", { query: SearchQuery, success: SearchResult }))
  .add(HttpApiEndpoint.get("listMachines", "/machines", { success: Schema.Array(MachineSummary) }))
  .add(
    HttpApiEndpoint.get("getMachine", "/machines/:id", {
      params: { id: Uuid },
      query: RangeQuery,
      success: MachineDetail,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("listProjects", "/projects", {
      query: RangeQuery,
      success: Schema.Array(ProjectRow),
    }),
  )
  .add(
    HttpApiEndpoint.get("getProject", "/projects/:key", {
      params: { key: NulFreeString },
      query: RangeQuery,
      success: ProjectDetail,
      error: NotFound,
    }),
  )
  .add(HttpApiEndpoint.get("listPlans", "/plans", { success: Schema.Array(SubscriptionPlan) }))
  .middleware(ReadAuth);

export const adminGroup = HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.post("createBookmark", "/bookmarks", {
      payload: BookmarkInput,
      success: BookmarkView,
      error: [NotFound, BadRequest],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateBookmark", "/bookmarks/:id", {
      params: { id: Uuid },
      payload: Schema.Struct({ note: BookmarkNote }),
      success: BookmarkView,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteBookmark", "/bookmarks/:id", {
      params: { id: Uuid },
      success: HttpApiSchema.NoContent,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("enroll", "/enroll", { payload: EnrollRequest, success: EnrollResponse }),
  )
  .add(
    HttpApiEndpoint.delete("deleteConversation", "/conversations/:id", {
      params: { id: Uuid },
      success: HttpApiSchema.NoContent,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("createPlan", "/plans", {
      payload: SubscriptionPlanInput,
      success: SubscriptionPlan,
      error: [PlanOverlap, PlanEndsBeforeStart],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updatePlan", "/plans/:id", {
      params: { id: Uuid },
      payload: SubscriptionPlanPatch,
      success: SubscriptionPlan,
      error: [NotFound, PlanOverlap, PlanEndsBeforeStart],
    }),
  )
  .add(
    HttpApiEndpoint.post("changePlan", "/plans/:id/change", {
      params: { id: Uuid },
      payload: SubscriptionPlanChange,
      success: SubscriptionPlan,
      error: [NotFound, PlanOverlap, PlanEndsBeforeStart],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deletePlan", "/plans/:id", {
      params: { id: Uuid },
      success: HttpApiSchema.NoContent,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("listCatalogs", "/pricing/catalogs", {
      success: Schema.Array(PricingCatalogView),
    }),
  )
  .add(
    HttpApiEndpoint.post("refreshPricing", "/pricing/refresh", {
      success: PricingCatalogView,
      error: BadRequest,
    }),
  )
  .add(
    HttpApiEndpoint.post("revalue", "/pricing/revalue", {
      payload: Schema.Struct({ catalogVersion: NulFreeString }),
      success: Schema.Struct({ queued: Schema.Boolean }),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("listRules", "/pricing/rules", { success: Schema.Array(PricingRuleView) }),
  )
  .add(
    HttpApiEndpoint.put("upsertRule", "/pricing/rules", {
      payload: PricingRuleInput,
      success: PricingRuleView,
      error: BadRequest,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteRule", "/pricing/rules", {
      query: { model: NulFreeString },
      success: HttpApiSchema.NoContent,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("listUnpricedModels", "/pricing/unpriced", {
      success: Schema.Array(UnpricedModelRow),
    }),
  )
  .add(HttpApiEndpoint.get("listTokens", "/tokens", { success: Schema.Array(ApiTokenView) }))
  .add(
    HttpApiEndpoint.post("createToken", "/tokens", {
      payload: Schema.Struct({ name: NulFreeString, scopes: Schema.Array(TokenScope) }),
      success: ApiTokenCreated,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteToken", "/tokens/:id", {
      params: { id: Uuid },
      success: HttpApiSchema.NoContent,
      error: NotFound,
    }),
  )
  .middleware(AdminAuth);

export const Api = HttpApi.make("turnstash")
  .add(HttpApiGroup.make("system").add(health))
  .add(ingestGroup)
  .add(readGroup)
  .add(adminGroup)
  .prefix("/api");
