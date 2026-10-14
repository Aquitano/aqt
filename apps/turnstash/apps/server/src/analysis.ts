import type {
  AllocationRow,
  Analysis,
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
import { activeCost, activeValuation, number, requestConditions } from "./filters.ts";

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
