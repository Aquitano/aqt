import type { TokenScope } from "@aqt/turnstash-api";
import type {
  HostOs,
  MessagePart,
  PricingRule,
  ProviderId,
  RequestSpeed,
  RouteId,
  TaskCategory,
  UnpricedReason,
} from "@aqt/turnstash-core";
import type { CostBreakdown } from "@aqt/turnstash-pricing";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  bytea,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Schema } from "effect";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const roleEnum = pgEnum("message_role", ["user", "assistant", "system", "tool"]);
export const usageBasisEnum = pgEnum("usage_basis", ["reported", "cumulative_delta", "estimated"]);
export const toolStatusEnum = pgEnum("tool_status", ["ok", "error", "unknown"]);

export const machines = pgTable(
  "machines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    os: text("os").$type<HostOs>().notNull(),
    arch: text("arch").notNull(),
    tokenHash: text("token_hash").notNull(),
    agentVersion: text("agent_version"),
    enrolledAt: timestamptz("enrolled_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at"),
  },
  (table) => [uniqueIndex("machines_token_hash").on(table.tokenHash)],
);

export const ingestBatches = pgTable("ingest_batches", {
  id: uuid("id").primaryKey(),
  machineId: uuid("machine_id")
    .notNull()
    .references(() => machines.id),
  receivedAt: timestamptz("received_at").notNull().defaultNow(),
  accepted: integer("accepted").notNull(),
  duplicates: integer("duplicates").notNull(),
  replaced: integer("replaced").notNull(),
});

export const sourceStreams = pgTable(
  "source_streams",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    machineId: uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    provider: text("provider").$type<ProviderId>().notNull(),
    streamId: text("stream_id").notNull(),
    firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_streams_identity").on(table.machineId, table.provider, table.streamId),
  ],
);

export const sourceRecords = pgTable(
  "source_records",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    streamRef: bigint("stream_ref", { mode: "number" })
      .notNull()
      .references(() => sourceStreams.id, { onDelete: "cascade" }),
    provider: text("provider").$type<ProviderId>().notNull(),
    recordKey: text("record_key").notNull(),
    contentHash: text("content_hash").notNull(),
    payload: text("payload").notNull(),
    observedAt: timestamptz("observed_at").notNull(),
    redactions: integer("redactions").notNull().default(0),
    conversationKey: text("conversation_key"),
    ingestedAt: timestamptz("ingested_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_records_identity").on(table.streamRef, table.recordKey),
    index("source_records_conversation").on(table.provider, table.conversationKey),
  ],
);

// Inline images and documents, each stored once under the sha256 that its markers in source_records name.
export const blobs = pgTable("blobs", {
  sha256: text("sha256").primaryKey(),
  data: bytea("data").notNull(),
});

export const recordBlobs = pgTable(
  "record_blobs",
  {
    recordId: bigint("record_id", { mode: "number" })
      .notNull()
      .references(() => sourceRecords.id, { onDelete: "cascade" }),
    sha256: text("sha256")
      .notNull()
      .references(() => blobs.sha256),
  },
  (table) => [
    primaryKey({ columns: [table.recordId, table.sha256] }),
    index("record_blobs_sha256").on(table.sha256),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").$type<ProviderId>().notNull(),
    conversationKey: text("conversation_key").notNull(),
    parentId: uuid("parent_id"),
    parentKey: text("parent_key"),
    title: text("title"),
    projectPath: text("project_path"),
    projectKey: text("project_key"),
    gitBranch: text("git_branch"),
    clientVersion: text("client_version"),
    startedAt: timestamptz("started_at").notNull(),
    endedAt: timestamptz("ended_at").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    requestCount: integer("request_count").notNull().default(0),
    parserVersion: integer("parser_version").notNull(),
    normalizedAt: timestamptz("normalized_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("conversations_identity").on(table.provider, table.conversationKey),
    index("conversations_started").on(table.startedAt),
    index("conversations_project").on(table.projectKey),
    index("conversations_project_path").on(table.projectPath),
  ],
);

export const conversationMachines = pgTable(
  "conversation_machines",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    machineId: uuid("machine_id")
      .notNull()
      .references(() => machines.id),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.machineId] })],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageKey: text("message_key").notNull(),
    seq: integer("seq").notNull(),
    turnIndex: integer("turn_index"),
    role: roleEnum("role").notNull(),
    parentMessageKey: text("parent_message_key"),
    createdAt: timestamptz("created_at").notNull(),
    parts: jsonb("parts").$type<ReadonlyArray<MessagePart>>().notNull(),
    text: text("text").notNull(),
  },
  (table) => [
    uniqueIndex("messages_identity").on(table.conversationId, table.messageKey),
    index("messages_order").on(table.conversationId, table.seq),
    index("messages_turn_order").on(table.conversationId, table.turnIndex, table.seq),
    index("messages_created").on(table.createdAt),
  ],
);

export const toolExecutions = pgTable(
  "tool_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageKey: text("message_key"),
    toolKey: text("tool_key").notNull(),
    name: text("name").notNull(),
    input: jsonb("input").$type<Schema.Json>(),
    output: text("output"),
    status: toolStatusEnum("status").notNull(),
    startedAt: timestamptz("started_at"),
    endedAt: timestamptz("ended_at"),
  },
  (table) => [uniqueIndex("tool_executions_identity").on(table.conversationId, table.toolKey)],
);

export const modelRequests = pgTable(
  "model_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    provider: text("provider").$type<ProviderId>().notNull(),
    messageKey: text("message_key"),
    requestKey: text("request_key").notNull(),
    modelRaw: text("model_raw").notNull(),
    modelId: text("model_id").notNull(),
    route: text("route").$type<RouteId>(),
    routeHint: text("route_hint"),
    requestedAt: timestamptz("requested_at").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    cacheWrite1hTokens: integer("cache_write_1h_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    reasoningTokens: integer("reasoning_tokens").notNull(),
    usageBasis: usageBasisEnum("usage_basis").notNull(),
    speed: text("speed").$type<RequestSpeed>(),
    sourceRecordKey: text("source_record_key"),
    turnIndex: integer("turn_index"),
  },
  (table) => [
    uniqueIndex("model_requests_identity").on(table.conversationId, table.requestKey),
    index("model_requests_time").on(table.requestedAt),
    index("model_requests_model").on(table.modelId),
  ],
);

export const conversationTurns = pgTable(
  "conversation_turns",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    turnIndex: integer("turn_index").notNull(),
    firstSeq: integer("first_seq").notNull(),
    startedAt: timestamptz("started_at").notNull(),
    userExcerpt: text("user_excerpt").notNull(),
    category: text("category").$type<TaskCategory>().notNull(),
    skill: text("skill"),
    primaryModelId: text("primary_model_id"),
    tools: text("tools").array().notNull(),
    skills: text("skills").array().notNull(),
    mcpServers: text("mcp_servers").array().notNull(),
    commands: text("commands").array().notNull(),
    edits: integer("edits").notNull(),
    retries: integer("retries").notNull(),
    analysisVersion: integer("analysis_version").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.turnIndex] }),
    index("conversation_turns_category").on(table.category),
  ],
);

export const pricingCatalogs = pgTable("pricing_catalogs", {
  version: text("version").primaryKey(),
  source: text("source").notNull(),
  fetchedAt: timestamptz("fetched_at").notNull().defaultNow(),
  active: boolean("active").notNull().default(false),
  pending: boolean("pending").notNull().default(false),
  recomputeFrom: timestamptz("recompute_from"),
  entries: jsonb("entries").$type<Schema.Json>().notNull(),
});

export const pricingRules = pgTable("pricing_rules", {
  model: text("model").primaryKey(),
  rule: jsonb("rule").$type<PricingRule>().notNull(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const valuations = pgTable(
  "valuations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => modelRequests.id, { onDelete: "cascade" }),
    catalogVersion: text("catalog_version")
      .notNull()
      .references(() => pricingCatalogs.version),
    priceKey: text("price_key"),
    costUsd: numeric("cost_usd", { precision: 16, scale: 10 }),
    unpricedReason: text("unpriced_reason").$type<UnpricedReason>(),
    breakdown: jsonb("breakdown").$type<CostBreakdown>(),
    computedAt: timestamptz("computed_at").notNull().defaultNow(),
    active: boolean("active").notNull().default(true),
    pricingVersion: integer("pricing_version").notNull().default(0),
  },
  (table) => [
    // Every cost aggregate joins the active valuation; keyed with its cost the join is index-only and skips
    // the rows kept for superseded catalogs. The pricing version keeps the worker's unvalued check index-only.
    index("valuations_active_cost")
      .on(table.requestId, table.costUsd, table.pricingVersion)
      .where(sql`${table.active}`),
    uniqueIndex("valuations_request_catalog").on(table.requestId, table.catalogVersion),
  ],
);

export const subscriptionPlans = pgTable("subscription_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").$type<ProviderId>().notNull(),
  name: text("name").notNull(),
  monthlyPrice: numeric("monthly_price", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  startedOn: date("started_on").notNull(),
  endedOn: date("ended_on"),
});

export const tombstones = pgTable(
  "tombstones",
  {
    provider: text("provider").$type<ProviderId>().notNull(),
    conversationKey: text("conversation_key").notNull(),
    deletedAt: timestamptz("deleted_at").notNull().defaultNow(),
    reason: text("reason"),
  },
  (table) => [primaryKey({ columns: [table.provider, table.conversationKey] })],
);

export const dirtyConversations = pgTable(
  "dirty_conversations",
  {
    provider: text("provider").$type<ProviderId>().notNull(),
    conversationKey: text("conversation_key").notNull(),
    markedAt: timestamptz("marked_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.provider, table.conversationKey] })],
);

export const bookmarks = pgTable(
  "bookmarks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"conversation" | "message" | "turn">().notNull(),
    messageKey: text("message_key").notNull().default(""),
    note: text("note").notNull().default(""),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bookmarks_target").on(table.conversationId, table.kind, table.messageKey),
    index("bookmarks_order").on(table.createdAt, table.id),
  ],
);

export const repositoryPaths = pgTable(
  "repository_paths",
  {
    machineId: uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    path: text("path").notNull(),
    repo: text("repo").notNull(),
    remote: text("remote"),
    observedAt: timestamptz("observed_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.machineId, table.path] }),
    index("repository_paths_repo").on(table.repo),
  ],
);

export const commits = pgTable(
  "commits",
  {
    repo: text("repo").notNull(),
    sha: text("sha").notNull(),
    parents: text("parents").array().notNull(),
    authoredAt: timestamptz("authored_at").notNull(),
    committedAt: timestamptz("committed_at").notNull(),
    subject: text("subject").notNull(),
    ref: text("ref").notNull(),
    onDefaultBranch: boolean("on_default_branch").notNull(),
    observedAt: timestamptz("observed_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.repo, table.sha] }),
    index("commits_repo_authored").on(table.repo, table.authoredAt),
  ],
);

export const commitLinks = pgTable(
  "commit_links",
  {
    repo: text("repo").notNull(),
    sha: text("sha").notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    linkedAt: timestamptz("linked_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.repo, table.sha] }),
    index("commit_links_conversation").on(table.conversationId),
    foreignKey({
      columns: [table.repo, table.sha],
      foreignColumns: [commits.repo, commits.sha],
    }).onDelete("cascade"),
  ],
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: text("scopes").$type<TokenScope>().array().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    lastUsedAt: timestamptz("last_used_at"),
  },
  (table) => [uniqueIndex("api_tokens_token_hash").on(table.tokenHash)],
);

export const dashboardSessions = pgTable("dashboard_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  subject: text("subject").notNull(),
  name: text("name").notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
});
