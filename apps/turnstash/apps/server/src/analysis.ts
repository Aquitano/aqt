import type {
  AllocationRow,
  Analysis,
  CacheBreak,
  CacheBreakReport,
  CategoryRow,
  ModelComparisonRow,
  StatsFilter,
  TurnView,
} from "@aqt/turnstash-api";
import type { TaskCategory } from "@aqt/turnstash-core";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { Db } from "./db/client.ts";
import {
  conversationTurns,
  conversations,
  messages,
  modelRequests,
  valuations,
} from "./db/schema.ts";
import { activeCost, activeValuation, dateWindow, number, requestConditions } from "./filters.ts";

// Every request in the filter lands in exactly one bucket: its turn, or "unattributed" when it has no turn.
const turnCosts = (filter: StatsFilter) => sql`
  SELECT ${modelRequests.conversationId} AS conversation_id, ${modelRequests.turnIndex} AS turn_index,
    ${activeCost} AS cost_usd, count(*) AS requests,
    coalesce(sum(${modelRequests.inputTokens}), 0) AS input_tokens,
    coalesce(sum(${modelRequests.cacheReadTokens}), 0) AS cache_read_tokens
  FROM ${modelRequests}
  JOIN ${conversations} ON ${conversations.id} = ${modelRequests.conversationId}
  LEFT JOIN ${valuations} ON ${activeValuation}
  WHERE ${requestConditions(filter) ?? sql`true`}
  GROUP BY ${modelRequests.conversationId}, ${modelRequests.turnIndex}`;

type AllocationColumn = "tools" | "commands" | "skills" | "mcp_servers";

const allocation = (column: AllocationColumn, filter: StatsFilter) => sql`
  WITH tc AS (${turnCosts(filter)})
  SELECT name, count(*)::int AS turns, coalesce(sum(tc.cost_usd / cardinality(t.${sql.raw(column)})), 0)::text AS cost_usd
  FROM tc
  JOIN ${conversationTurns} AS t ON t.conversation_id = tc.conversation_id AND t.turn_index = tc.turn_index
  CROSS JOIN unnest(t.${sql.raw(column)}) AS name
  GROUP BY name
  ORDER BY sum(tc.cost_usd / cardinality(t.${sql.raw(column)})) DESC, name
  LIMIT 60`;

type AllocationRaw = {
  readonly name: string;
  readonly turns: number;
  readonly cost_usd: string;
};

const allocationRows = (rows: ReadonlyArray<AllocationRaw>): Array<AllocationRow> =>
  rows.map((row) => ({
    name: row.name,
    turns: number(row.turns),
    estimatedCostUsd: number(row.cost_usd),
  }));

// A rewrite this small is ordinary growth at the end of a conversation's cached prefix.
const minimumRewriteTokens = 20_000;
const cacheBreakRowLimit = 40;
const lookbackMs = 86_400_000;

// A request that rewrites most of what the previous request of its conversation had cached. Only its cost to
// write counts, because reading the same tokens would have cost about a tenth of it. The earlier day stays in
// the scan so the first request of the period still has a predecessor.
const cacheBreakRows = (filter: StatsFilter) => {
  const from = dateWindow(filter).from;
  const scanned =
    from === null
      ? filter
      : { ...filter, from: new Date(from.getTime() - lookbackMs).toISOString() };
  const written = sql`(${modelRequests.cacheWriteTokens} + ${modelRequests.cacheWrite1hTokens})`;
  const cached = sql`(${modelRequests.cacheReadTokens} + ${written})`;
  return sql`
    WITH ordered AS (
      SELECT ${modelRequests.id} AS id, ${modelRequests.conversationId} AS conversation_id,
        ${modelRequests.messageKey} AS message_key, ${modelRequests.provider} AS provider,
        ${modelRequests.modelId} AS model_id, ${modelRequests.requestedAt} AS requested_at,
        ${modelRequests.cacheReadTokens} AS cache_read_tokens, ${written} AS written,
        ${modelRequests.cacheWrite1hTokens} AS written_1h,
        lag(${modelRequests.requestedAt}) OVER turn AS previous_at,
        lag(${cached}) OVER turn AS previous_cached
      FROM ${modelRequests}
      JOIN ${conversations} ON ${conversations.id} = ${modelRequests.conversationId}
      WHERE ${requestConditions(scanned) ?? sql`true`}
      WINDOW turn AS (PARTITION BY ${modelRequests.conversationId} ORDER BY ${modelRequests.requestedAt}, ${modelRequests.id})
    )
    SELECT o.id, o.conversation_id, ${conversations.title} AS title, o.message_key, o.provider, o.model_id,
      o.requested_at, o.cache_read_tokens, o.written,
      extract(epoch FROM o.requested_at - o.previous_at) / 60 AS idle_minutes,
      extract(epoch FROM o.requested_at - o.previous_at) / 60 <= (CASE WHEN o.written_1h > 0 THEN 60 ELSE 5 END) AS within_lifetime,
      coalesce((${valuations.breakdown} ->> 'cacheWriteUsd')::numeric, 0) + coalesce((${valuations.breakdown} ->> 'cacheWrite1hUsd')::numeric, 0) AS rewrite_cost
    FROM ordered AS o
    JOIN ${conversations} ON ${conversations.id} = o.conversation_id
    LEFT JOIN ${valuations} ON ${valuations.requestId} = o.id AND ${valuations.active}
    WHERE o.written >= ${minimumRewriteTokens}
      AND o.cache_read_tokens < o.written * 0.1
      AND o.written >= o.previous_cached * 0.5
      AND o.previous_cached >= ${minimumRewriteTokens}
      ${from === null ? sql`` : sql`AND o.requested_at >= ${from.toISOString()}::timestamptz`}`;
};

type CacheBreakRaw = {
  readonly id: string;
  readonly conversation_id: string;
  readonly title: string | null;
  readonly message_key: string | null;
  readonly provider: CacheBreak["provider"];
  readonly model_id: string;
  readonly requested_at: Date | string;
  readonly cache_read_tokens: number;
  readonly written: number;
  readonly idle_minutes: string | number;
  readonly within_lifetime: boolean;
  readonly rewrite_cost: string | number;
};

export const cacheBreaks = Effect.fn("Analysis.cacheBreaks")(function* (filter: StatsFilter) {
  const db = yield* Db;
  const matches = cacheBreakRows(filter);
  const [totals] = yield* db.execute<{
    readonly breaks: number;
    readonly within_lifetime: number;
    readonly rewrite_cost: string;
    readonly written: string;
  }>(
    sql`
    WITH matches AS (${matches})
    SELECT count(*)::int AS breaks, count(*) FILTER (WHERE within_lifetime)::int AS within_lifetime,
      coalesce(sum(rewrite_cost), 0)::text AS rewrite_cost, coalesce(sum(written), 0)::text AS written
    FROM matches`,
    "objects",
  );
  const rows = yield* db.execute<CacheBreakRaw>(
    sql`
    WITH matches AS (${matches})
    SELECT * FROM matches ORDER BY within_lifetime DESC, rewrite_cost DESC LIMIT ${cacheBreakRowLimit}`,
    "objects",
  );
  const report: CacheBreakReport = {
    breaks: number(totals?.breaks),
    withinLifetime: number(totals?.within_lifetime),
    rewriteCostUsd: number(totals?.rewrite_cost),
    writtenTokens: number(totals?.written),
    rows: rows.map((row): CacheBreak => ({
      requestId: row.id,
      conversationId: row.conversation_id,
      conversationTitle: row.title,
      messageKey: row.message_key,
      provider: row.provider,
      modelId: row.model_id,
      requestedAt: new Date(row.requested_at).toISOString(),
      idleMinutes: number(row.idle_minutes),
      withinLifetime: row.within_lifetime,
      cacheWriteTokens: number(row.written),
      cacheReadTokens: number(row.cache_read_tokens),
      rewriteCostUsd: number(row.rewrite_cost),
    })),
  };
  return report;
});

export const computeAnalysis = Effect.fn("Analysis.compute")(function* (filter: StatsFilter) {
  const db = yield* Db;
  // Independent statements over the same turn costs; they share the pool instead of queueing one after another.
  const { byCategory, byModel, totals, byTool, byCommand, bySkill, byMcpServer } =
    yield* Effect.all(
      {
        byCategory: db.execute<{
          category: TaskCategory;
          turns: number;
          edit_turns: number;
          retries: number;
          cost_usd: string;
        }>(
          sql`
    WITH tc AS (${turnCosts(filter)})
    SELECT t.category, count(*)::int AS turns,
      count(*) FILTER (WHERE t.edits > 0)::int AS edit_turns,
      coalesce(sum(t.retries), 0)::int AS retries,
      coalesce(sum(tc.cost_usd), 0)::text AS cost_usd
    FROM tc JOIN ${conversationTurns} AS t ON t.conversation_id = tc.conversation_id AND t.turn_index = tc.turn_index
    GROUP BY t.category ORDER BY sum(tc.cost_usd) DESC, t.category`,
          "objects",
        ),
        byModel: db.execute<{
          model_id: string;
          turns: number;
          edit_turns: number;
          retries: number;
          requests: number;
          rg_turns: number;
          grep_turns: number;
          cost_usd: string;
          input_tokens: string;
          cache_read_tokens: string;
        }>(
          sql`
    WITH tc AS (${turnCosts(filter)})
    SELECT coalesce(t.primary_model_id, 'unknown') AS model_id, count(*)::int AS turns,
      count(*) FILTER (WHERE t.edits > 0)::int AS edit_turns,
      coalesce(sum(t.retries), 0)::int AS retries,
      coalesce(sum(tc.requests), 0)::int AS requests,
      count(*) FILTER (WHERE 'rg' = ANY(t.commands))::int AS rg_turns,
      count(*) FILTER (WHERE 'grep' = ANY(t.commands))::int AS grep_turns,
      coalesce(sum(tc.cost_usd), 0)::text AS cost_usd,
      coalesce(sum(tc.input_tokens), 0)::text AS input_tokens,
      coalesce(sum(tc.cache_read_tokens), 0)::text AS cache_read_tokens
    FROM tc JOIN ${conversationTurns} AS t ON t.conversation_id = tc.conversation_id AND t.turn_index = tc.turn_index
    GROUP BY coalesce(t.primary_model_id, 'unknown') ORDER BY sum(tc.cost_usd) DESC, model_id`,
          "objects",
        ),
        totals: db.execute<{ attributed: string; unattributed: string }>(
          sql`
    WITH tc AS (${turnCosts(filter)})
    SELECT coalesce(sum(cost_usd) FILTER (WHERE turn_index IS NOT NULL), 0)::text AS attributed,
      coalesce(sum(cost_usd) FILTER (WHERE turn_index IS NULL), 0)::text AS unattributed
    FROM tc`,
          "objects",
        ),
        byTool: db.execute<AllocationRaw>(allocation("tools", filter), "objects"),
        byCommand: db.execute<AllocationRaw>(allocation("commands", filter), "objects"),
        bySkill: db.execute<AllocationRaw>(allocation("skills", filter), "objects"),
        byMcpServer: db.execute<AllocationRaw>(allocation("mcp_servers", filter), "objects"),
      },
      { concurrency: 4 },
    );
  return {
    byCategory: byCategory.map((row): CategoryRow => ({
      category: row.category,
      turns: number(row.turns),
      editTurns: number(row.edit_turns),
      retries: number(row.retries),
      costUsd: number(row.cost_usd),
    })),
    byModel: byModel.map((row): ModelComparisonRow => {
      const prompt = number(row.input_tokens) + number(row.cache_read_tokens);
      return {
        modelId: row.model_id,
        turns: number(row.turns),
        editTurns: number(row.edit_turns),
        retries: number(row.retries),
        requests: number(row.requests),
        rgTurns: number(row.rg_turns),
        grepTurns: number(row.grep_turns),
        costUsd: number(row.cost_usd),
        cacheHitRate: prompt === 0 ? null : number(row.cache_read_tokens) / prompt,
      };
    }),
    byTool: allocationRows(byTool),
    byCommand: allocationRows(byCommand),
    bySkill: allocationRows(bySkill),
    byMcpServer: allocationRows(byMcpServer),
    attributedCostUsd: number(totals[0]?.attributed),
    unattributedCostUsd: number(totals[0]?.unattributed),
  } satisfies Analysis;
});

export const conversationTurnViews = Effect.fn("Analysis.turns")(function* (
  conversationId: string,
) {
  const db = yield* Db;
  const costs = db
    .select({
      turnIndex: modelRequests.turnIndex,
      requests: count().as("requests"),
      costUsd: activeCost.as("cost_usd"),
    })
    .from(modelRequests)
    .leftJoin(valuations, activeValuation)
    .where(eq(modelRequests.conversationId, conversationId))
    .groupBy(modelRequests.turnIndex)
    .as("costs");
  const rows = yield* db
    .select({
      turn: conversationTurns,
      requests: costs.requests,
      costUsd: costs.costUsd,
      messageKey: messages.messageKey,
    })
    .from(conversationTurns)
    .leftJoin(costs, eq(costs.turnIndex, conversationTurns.turnIndex))
    .leftJoin(
      messages,
      and(
        eq(messages.conversationId, conversationTurns.conversationId),
        eq(messages.seq, conversationTurns.firstSeq),
      ),
    )
    .where(eq(conversationTurns.conversationId, conversationId))
    .orderBy(asc(conversationTurns.turnIndex));
  return rows.map(({ turn, requests, costUsd, messageKey }): TurnView => ({
    turnIndex: turn.turnIndex,
    messageKey,
    startedAt: turn.startedAt.toISOString(),
    userExcerpt: turn.userExcerpt,
    category: turn.category,
    skill: turn.skill,
    primaryModelId: turn.primaryModelId,
    tools: turn.tools,
    commands: turn.commands,
    edits: turn.edits,
    retries: turn.retries,
    requests: number(requests),
    costUsd: number(costUsd),
  }));
});
