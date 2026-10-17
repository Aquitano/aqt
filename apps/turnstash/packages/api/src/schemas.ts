import {
  HostOs,
  IsoDate,
  IsoTimestamp,
  MessagePart,
  NulFreeString,
  PricingRule,
  ProviderId,
  Role,
  RouteId,
  TaskCategory,
  ToolStatus,
  UnpricedReason,
  UsageBasis,
  Uuid,
} from "@aqt/turnstash-core";
import { Schema } from "effect";

export const Iso = IsoTimestamp;
export const Money = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
export const Currency = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/));
export { NulFreeString, ProviderId, Uuid };
export { EnrollRequest, providerIds, providerLabels } from "@aqt/turnstash-core";
export const PageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }));

export const BookmarkNote = Schema.String.check(Schema.isMaxLength(1000));
const MessageKey = NulFreeString.check(Schema.isNonEmpty());
export const BookmarkTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("conversation") }),
  Schema.Struct({ kind: Schema.Literal("message"), messageKey: MessageKey }),
  Schema.Struct({ kind: Schema.Literal("turn"), messageKey: MessageKey }),
]);
export type BookmarkTarget = typeof BookmarkTarget.Type;
export const BookmarkInput = Schema.Struct({
  conversationId: Uuid,
  target: BookmarkTarget,
  note: Schema.optionalKey(BookmarkNote),
});
export type BookmarkInput = typeof BookmarkInput.Type;
export const BookmarkView = Schema.Struct({
  id: Uuid,
  conversationId: Uuid,
  conversationTitle: Schema.NullOr(Schema.String),
  target: BookmarkTarget,
  note: BookmarkNote,
  excerpt: Schema.String,
  available: Schema.Boolean,
  createdAt: Iso,
  updatedAt: Iso,
});
export type BookmarkView = typeof BookmarkView.Type;
export const BookmarkPage = Schema.Struct({
  items: Schema.Array(BookmarkView),
  nextCursor: Schema.NullOr(Uuid),
});
export const ExportSelection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("conversation") }),
  Schema.Struct({
    kind: Schema.Literal("messages"),
    messageKeys: Schema.Array(MessageKey).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  }),
  Schema.Struct({
    kind: Schema.Literal("turns"),
    messageKeys: Schema.Array(MessageKey).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  }),
]);
export type ExportSelection = typeof ExportSelection.Type;
export const MarkdownExportInput = Schema.Struct({
  selection: ExportSelection,
  includeTools: Schema.optionalKey(Schema.Boolean),
  sourceOrigin: Schema.optionalKey(
    Schema.String.check(
      Schema.makeFilter((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
      }),
    ),
  ),
});
export type MarkdownExportInput = typeof MarkdownExportInput.Type;
export const MarkdownExport = Schema.Struct({ filename: Schema.String, markdown: Schema.String });
export type MarkdownExport = typeof MarkdownExport.Type;

export const ConversationCursor = Schema.String.check(
  Schema.isPattern(/^-?\d{1,16}\|[0-9a-f-]{36}$/i),
  Schema.makeFilter((value) => {
    const [time, id] = value.split("|");
    return Number.isFinite(new Date(Number(time)).getTime()) && Schema.is(Uuid)(id);
  }),
);
export const MessageCursor = Schema.String.check(
  Schema.isPattern(/^\d{1,10}$/),
  Schema.makeFilter((value) => Number(value) <= 2_147_483_647),
);

// A date-only upper bound is widened to the next midnight, which must stay inside the four-digit years
// PostgreSQL parses.
export const DateBoundary = Schema.Union([IsoDate, IsoTimestamp]).check(
  Schema.makeFilter((value) => value < "9999-12-31"),
);
export const DateRange = Schema.Struct({ from: DateBoundary, to: DateBoundary });
export type DateRange = typeof DateRange.Type;

// Only names: Intl also accepts offsets such as +05:30, which PostgreSQL reads as POSIX zones with the sign flipped.
export const TimeZone = Schema.String.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_+/-]*$/),
  Schema.makeFilter((timeZone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone });
      return true;
    } catch {
      return false;
    }
  }),
);

export const StatsFilter = Schema.Struct({
  from: Schema.optionalKey(DateBoundary),
  to: Schema.optionalKey(DateBoundary),
  timeZone: Schema.optionalKey(TimeZone),
  provider: Schema.optionalKey(ProviderId),
  machineId: Schema.optionalKey(Uuid),
  projectKey: Schema.optionalKey(NulFreeString),
});
export type StatsFilter = typeof StatsFilter.Type;

export const TokenTotals = Schema.Struct({
  inputTokens: Schema.Natural,
  cacheReadTokens: Schema.Natural,
  cacheWriteTokens: Schema.Natural,
  outputTokens: Schema.Natural,
  reasoningTokens: Schema.Natural,
});

export const Overall = Schema.Struct({
  ...TokenTotals.fields,
  costUsd: Money,
  unpricedRequests: Schema.Natural,
  requests: Schema.Natural,
  conversations: Schema.Natural,
  messages: Schema.Natural,
});
export type Overall = typeof Overall.Type;

export const ModelRow = Schema.Struct({
  modelId: Schema.String,
  route: Schema.NullOr(RouteId),
  requests: Schema.Natural,
  costUsd: Money,
  inputTokens: Schema.Natural,
  outputTokens: Schema.Natural,
  cacheReadTokens: Schema.Natural,
  cacheWriteTokens: Schema.Natural,
});
export type ModelRow = typeof ModelRow.Type;

export const ProviderRow = Schema.Struct({
  provider: ProviderId,
  requests: Schema.Natural,
  conversations: Schema.Natural,
  costUsd: Money,
  inputTokens: Schema.Natural,
  outputTokens: Schema.Natural,
});
export type ProviderRow = typeof ProviderRow.Type;

export const ProjectRow = Schema.Struct({
  projectKey: Schema.String,
  projectPath: Schema.NullOr(Schema.String),
  requests: Schema.Natural,
  conversations: Schema.Natural,
  costUsd: Money,
});
export type ProjectRow = typeof ProjectRow.Type;

export const MachineSummary = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  os: HostOs,
  arch: Schema.String,
  agentVersion: Schema.NullOr(Schema.String),
  enrolledAt: Iso,
  lastSeenAt: Schema.NullOr(Iso),
  costUsd: Money,
  conversations: Schema.Natural,
});
export type MachineSummary = typeof MachineSummary.Type;

export const DayRow = Schema.Struct({
  date: Schema.String,
  requests: Schema.Natural,
  conversations: Schema.Natural,
  costUsd: Money,
  inputTokens: Schema.Natural,
  outputTokens: Schema.Natural,
  cacheReadTokens: Schema.Natural,
  cacheWriteTokens: Schema.Natural,
});
export type DayRow = typeof DayRow.Type;

export const FlowLink = Schema.Struct({
  modelId: Schema.String,
  projectKey: Schema.String,
  costUsd: Money,
});
export type FlowLink = typeof FlowLink.Type;

export const ConversationSummary = Schema.Struct({
  id: Uuid,
  provider: ProviderId,
  conversationKey: Schema.String,
  parentId: Schema.NullOr(Uuid),
  title: Schema.NullOr(Schema.String),
  projectKey: Schema.NullOr(Schema.String),
  projectPath: Schema.NullOr(Schema.String),
  gitBranch: Schema.NullOr(Schema.String),
  startedAt: Iso,
  endedAt: Iso,
  messageCount: Schema.Natural,
  requestCount: Schema.Natural,
  costUsd: Money,
  machineIds: Schema.Array(Uuid),
});
export type ConversationSummary = typeof ConversationSummary.Type;

export const PlanCost = Schema.Struct({ currency: Currency, amount: Money });
export type PlanCost = typeof PlanCost.Type;

// Plan cost prorated to the window beside what the provider's requests would have cost at API rates. Plans
// keep the currency they are billed in, so a provider paid in two currencies has one cost per currency.
export const SubscriptionValue = Schema.Struct({
  provider: ProviderId,
  plans: Schema.Array(Schema.String),
  planCosts: Schema.Array(PlanCost),
  apiUsd: Money,
});
export type SubscriptionValue = typeof SubscriptionValue.Type;

export const Stats = Schema.Struct({
  generatedAt: Iso,
  range: Schema.NullOr(DateRange),
  dataStart: Schema.NullOr(Schema.String),
  overall: Overall,
  byProvider: Schema.Array(ProviderRow),
  byModel: Schema.Array(ModelRow),
  byProject: Schema.Array(ProjectRow),
  byMachine: Schema.Array(MachineSummary),
  daily: Schema.Array(DayRow),
  topConversations: Schema.Array(ConversationSummary),
  flow: Schema.Array(FlowLink),
  subscriptions: Schema.Array(SubscriptionValue),
});
export type Stats = typeof Stats.Type;

export const StatsDaily = Schema.Struct({
  dataStart: Schema.NullOr(Schema.String),
  daily: Schema.Array(DayRow),
});
export type StatsDaily = typeof StatsDaily.Type;

export const ConversationListQuery = Schema.Struct({
  ...StatsFilter.fields,
  q: Schema.optionalKey(NulFreeString),
  cursor: Schema.optionalKey(ConversationCursor),
  limit: Schema.optionalKey(PageLimit),
});
export type ConversationListQuery = typeof ConversationListQuery.Type;

export const ConversationPage = Schema.Struct({
  items: Schema.Array(ConversationSummary),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ConversationPage = typeof ConversationPage.Type;

export const RequestUnpricedReason = Schema.Literals([...UnpricedReason.literals, "pending"]);
export type RequestUnpricedReason = typeof RequestUnpricedReason.Type;

export const RequestSummary = Schema.Struct({
  id: Uuid,
  conversationId: Uuid,
  messageKey: Schema.NullOr(Schema.String),
  requestKey: Schema.String,
  modelRaw: Schema.String,
  modelId: Schema.String,
  route: Schema.NullOr(RouteId),
  requestedAt: Iso,
  inputTokens: Schema.Natural,
  cacheReadTokens: Schema.Natural,
  cacheWriteTokens: Schema.Natural,
  cacheWrite1hTokens: Schema.Natural,
  outputTokens: Schema.Natural,
  reasoningTokens: Schema.Natural,
  usageBasis: UsageBasis,
  costUsd: Schema.NullOr(Money),
  unpricedReason: Schema.NullOr(RequestUnpricedReason),
});
export type RequestSummary = typeof RequestSummary.Type;

export const ToolExecutionView = Schema.Struct({
  id: Uuid,
  toolKey: Schema.String,
  messageKey: Schema.NullOr(Schema.String),
  name: Schema.String,
  input: Schema.Json,
  output: Schema.NullOr(Schema.String),
  status: ToolStatus,
  startedAt: Schema.NullOr(Iso),
  endedAt: Schema.NullOr(Iso),
});
export type ToolExecutionView = typeof ToolExecutionView.Type;

export const MessageView = Schema.Struct({
  id: Uuid,
  messageKey: Schema.String,
  seq: Schema.Natural,
  role: Role,
  parentMessageKey: Schema.NullOr(Schema.String),
  createdAt: Iso,
  parts: Schema.Array(MessagePart),
  requests: Schema.Array(RequestSummary),
});
export type MessageView = typeof MessageView.Type;

export const MessagePage = Schema.Struct({
  items: Schema.Array(MessageView),
  toolExecutions: Schema.Array(ToolExecutionView),
  previousCursor: Schema.NullOr(Schema.String),
  nextCursor: Schema.NullOr(Schema.String),
});
export type MessagePage = typeof MessagePage.Type;

export const MessageQuery = Schema.Struct({
  cursor: Schema.optionalKey(MessageCursor),
  before: Schema.optionalKey(MessageCursor),
  message: Schema.optionalKey(NulFreeString.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  limit: Schema.optionalKey(PageLimit),
}).check(
  Schema.makeFilter(
    (query) =>
      [query.cursor, query.before, query.message].filter((value) => value !== undefined).length <=
      1,
  ),
);
export type MessageQuery = typeof MessageQuery.Type;

export const TimelineCursor = NulFreeString.check(Schema.isPattern(/^(request|tool):/));
export const TimelineVersion = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/));

export const TimelineEvent = Schema.Struct({
  eventKey: TimelineCursor,
  kind: Schema.Literals(["request", "tool"]),
  timestamp: Schema.NullOr(Iso),
  messageKey: Schema.NullOr(Schema.String),
  requestId: Schema.NullOr(Uuid),
  modelId: Schema.NullOr(Schema.String),
  previousModelId: Schema.NullOr(Schema.String),
  toolName: Schema.NullOr(Schema.String),
  toolStatus: Schema.NullOr(ToolStatus),
  costUsd: Schema.NullOr(Money),
  unpricedReason: Schema.NullOr(RequestUnpricedReason),
  cumulativeCostUsd: Money,
  cumulativeUnpricedRequests: Schema.Natural,
});
export interface TimelineEvent extends Schema.Schema.Type<typeof TimelineEvent> {}

export const TimelinePage = Schema.Struct({
  version: TimelineVersion,
  items: Schema.Array(TimelineEvent),
  nextCursor: Schema.NullOr(TimelineCursor),
  totalEvents: Schema.Natural,
  pricedCostUsd: Money,
  unpricedRequests: Schema.Natural,
});
export interface TimelinePage extends Schema.Schema.Type<typeof TimelinePage> {}

export const CategoryRow = Schema.Struct({
  category: TaskCategory,
  turns: Schema.Natural,
  editTurns: Schema.Natural,
  retries: Schema.Natural,
  costUsd: Money,
});
export type CategoryRow = typeof CategoryRow.Type;

export const AllocationRow = Schema.Struct({
  name: Schema.String,
  turns: Schema.Natural,
  estimatedCostUsd: Money,
});
export type AllocationRow = typeof AllocationRow.Type;

export const ModelComparisonRow = Schema.Struct({
  modelId: Schema.String,
  turns: Schema.Natural,
  editTurns: Schema.Natural,
  retries: Schema.Natural,
  requests: Schema.Natural,
  rgTurns: Schema.Natural,
  grepTurns: Schema.Natural,
  costUsd: Money,
  cacheHitRate: Schema.NullOr(Schema.Finite),
});
export type ModelComparisonRow = typeof ModelComparisonRow.Type;

export const Analysis = Schema.Struct({
  byCategory: Schema.Array(CategoryRow),
  byModel: Schema.Array(ModelComparisonRow),
  byTool: Schema.Array(AllocationRow),
  byCommand: Schema.Array(AllocationRow),
  bySkill: Schema.Array(AllocationRow),
  byMcpServer: Schema.Array(AllocationRow),
  attributedCostUsd: Money,
  unattributedCostUsd: Money,
});
export type Analysis = typeof Analysis.Type;

export const TurnView = Schema.Struct({
  turnIndex: Schema.Natural,
  messageKey: Schema.NullOr(Schema.String),
  startedAt: Iso,
  userExcerpt: Schema.String,
  category: TaskCategory,
  skill: Schema.NullOr(Schema.String),
  primaryModelId: Schema.NullOr(Schema.String),
  tools: Schema.Array(Schema.String),
  commands: Schema.Array(Schema.String),
  edits: Schema.Natural,
  retries: Schema.Natural,
  requests: Schema.Natural,
  costUsd: Money,
});
export type TurnView = typeof TurnView.Type;

export const CommitView = Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  subject: Schema.String,
  authoredAt: Iso,
  committedAt: Iso,
  ref: Schema.String,
  onDefaultBranch: Schema.Boolean,
  remote: Schema.NullOr(Schema.String),
  conversationId: Uuid,
  costUsd: Money,
});
export type CommitView = typeof CommitView.Type;

export const MachineRef = Schema.Struct({ id: Uuid, name: Schema.String });
export type MachineRef = typeof MachineRef.Type;

export const ConversationDetail = Schema.Struct({
  conversation: ConversationSummary,
  children: Schema.Array(ConversationSummary),
  machines: Schema.Array(MachineRef),
  byModel: Schema.Array(ModelRow),
  redactions: Schema.Natural,
  commits: Schema.Array(CommitView),
  turns: Schema.Array(TurnView),
  requestsWithoutMessage: Schema.Array(RequestSummary),
});
export type ConversationDetail = typeof ConversationDetail.Type;

export const ValuationView = Schema.Struct({
  catalogVersion: Schema.String,
  priceKey: Schema.NullOr(Schema.String),
  costUsd: Schema.NullOr(Money),
  unpricedReason: Schema.NullOr(UnpricedReason),
  breakdown: Schema.Json,
  computedAt: Iso,
  active: Schema.Boolean,
});
export type ValuationView = typeof ValuationView.Type;

export const RequestDetail = Schema.Struct({
  request: RequestSummary,
  provider: ProviderId,
  conversationKey: Schema.String,
  conversationTitle: Schema.NullOr(Schema.String),
  valuations: Schema.Array(ValuationView),
  priceEntry: Schema.Json,
  sourceRecord: Schema.NullOr(
    Schema.Struct({ streamId: Schema.String, recordKey: Schema.String, machineId: Uuid }),
  ),
});
export type RequestDetail = typeof RequestDetail.Type;

export const SearchQuery = Schema.Struct({
  q: NulFreeString.check(
    Schema.isMaxLength(1024),
    Schema.makeFilter((value) => value.trim().length > 0),
    Schema.makeFilter((value) => !value.includes("*")),
  ),
  provider: Schema.optionalKey(ProviderId),
  projectKey: Schema.optionalKey(NulFreeString),
  role: Schema.optionalKey(Role),
  from: Schema.optionalKey(DateBoundary),
  to: Schema.optionalKey(DateBoundary),
  limit: Schema.optionalKey(PageLimit),
});
export type SearchQuery = typeof SearchQuery.Type;

export const SearchHit = Schema.Struct({
  conversationId: Uuid,
  messageId: Uuid,
  messageKey: Schema.String,
  seq: Schema.Natural,
  role: Role,
  provider: ProviderId,
  title: Schema.NullOr(Schema.String),
  projectKey: Schema.NullOr(Schema.String),
  createdAt: Iso,
  snippet: Schema.String,
  score: Schema.Finite,
});
export type SearchHit = typeof SearchHit.Type;

export const SearchResult = Schema.Struct({ hits: Schema.Array(SearchHit) });
export type SearchResult = typeof SearchResult.Type;

export const MachineDetail = Schema.Struct({
  machine: MachineSummary,
  streamCount: Schema.Natural,
  streams: Schema.Array(
    Schema.Struct({
      provider: ProviderId,
      streamId: Schema.String,
      records: Schema.Natural,
      lastSeenAt: Iso,
    }),
  ),
  stats: Stats,
});
export type MachineDetail = typeof MachineDetail.Type;

export const ProjectDetail = Schema.Struct({
  projectKey: Schema.String,
  projectPath: Schema.NullOr(Schema.String),
  stats: Stats,
  commits: Schema.Array(CommitView),
});
export type ProjectDetail = typeof ProjectDetail.Type;

export const SubscriptionPlan = Schema.Struct({
  id: Uuid,
  provider: ProviderId,
  name: Schema.String,
  monthlyPrice: Money,
  currency: Currency,
  startedOn: IsoDate,
  endedOn: Schema.NullOr(IsoDate),
});
export type SubscriptionPlan = typeof SubscriptionPlan.Type;

export const SubscriptionPlanInput = Schema.Struct({
  provider: ProviderId,
  name: NulFreeString,
  monthlyPrice: Money,
  currency: Schema.optionalKey(Currency),
  startedOn: IsoDate,
  endedOn: Schema.optionalKey(Schema.NullOr(IsoDate)),
});
export type SubscriptionPlanInput = typeof SubscriptionPlanInput.Type;

export const SubscriptionPlanPatch = Schema.Struct({
  provider: Schema.optionalKey(ProviderId),
  name: Schema.optionalKey(NulFreeString),
  monthlyPrice: Schema.optionalKey(Money),
  currency: Schema.optionalKey(Currency),
  startedOn: Schema.optionalKey(IsoDate),
  endedOn: Schema.optionalKey(Schema.NullOr(IsoDate)),
});
export type SubscriptionPlanPatch = typeof SubscriptionPlanPatch.Type;

// Ends a period the day before effectiveOn and opens the new plan from that day; currency defaults to the
// ended period's.
export const SubscriptionPlanChange = Schema.Struct({
  name: NulFreeString,
  monthlyPrice: Money,
  currency: Schema.optionalKey(Currency),
  effectiveOn: IsoDate,
});
export type SubscriptionPlanChange = typeof SubscriptionPlanChange.Type;

export const TokenScope = Schema.Literals(["read", "admin"]);
export type TokenScope = typeof TokenScope.Type;

export const ApiTokenView = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  scopes: Schema.Array(TokenScope),
  createdAt: Iso,
  lastUsedAt: Schema.NullOr(Iso),
});
export type ApiTokenView = typeof ApiTokenView.Type;

export const ApiTokenCreated = Schema.Struct({ token: ApiTokenView, secret: Schema.String });
export type ApiTokenCreated = typeof ApiTokenCreated.Type;

export const PricingCatalogView = Schema.Struct({
  version: Schema.String,
  source: Schema.String,
  fetchedAt: Iso,
  active: Schema.Boolean,
  pending: Schema.Boolean,
  entries: Schema.Natural,
  rules: Schema.Natural,
});
export type PricingCatalogView = typeof PricingCatalogView.Type;

export const Repricing = Schema.Struct({
  version: Schema.String,
  done: Schema.Natural,
  total: Schema.Natural,
});
export type Repricing = typeof Repricing.Type;

export { PricingRule };

export const PricingRuleInput = Schema.Struct({ model: NulFreeString, rule: PricingRule });
export type PricingRuleInput = typeof PricingRuleInput.Type;

export const PricingRuleView = Schema.Struct({
  model: Schema.String,
  rule: PricingRule,
  updatedAt: Iso,
});
export type PricingRuleView = typeof PricingRuleView.Type;

export const UnpricedModelRow = Schema.Struct({
  modelRaw: Schema.String,
  modelId: Schema.String,
  provider: ProviderId,
  requests: Schema.Natural,
  reason: Schema.NullOr(UnpricedReason),
  lastSeenAt: Iso,
});
export type UnpricedModelRow = typeof UnpricedModelRow.Type;

export const Health = Schema.Struct({
  ok: Schema.Boolean,
  version: Schema.String,
  dirtyConversations: Schema.Natural,
  activeCatalog: Schema.NullOr(Schema.String),
  repricing: Schema.NullOr(Repricing),
});
export type Health = typeof Health.Type;
