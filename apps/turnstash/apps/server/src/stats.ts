import {
  type DayRow,
  type FlowLink,
  type MachineDetail,
  type MachineSummary,
  type ModelRow,
  NotFound,
  type Overall,
  type ProjectDetail,
  type ProjectRow,
  type ProviderRow,
  type Stats,
  type StatsDaily,
  type StatsFilter,
  type SubscriptionValue,
} from "@aqt/turnstash-api";
import type { ProviderId } from "@aqt/turnstash-core";
import { getTimezone } from "countries-and-timezones";
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  lt,
  max,
  min,
  sql,
  sum,
} from "drizzle-orm";
import { Effect } from "effect";

import { conversationSummaries } from "./conversations.ts";
import { type Database, Db } from "./db/client.ts";
import {
  conversationMachines,
  conversations,
  machines,
  messages,
  modelRequests,
  sourceRecords,
  sourceStreams,
  subscriptionPlans,
  valuations,
} from "./db/schema.ts";
import {
  activeCost,
  activeValuation,
  dateWindow,
  number,
  projectCondition,
  requestConditions,
  unknownProject,
} from "./filters.ts";
import { commitsForProject } from "./git.ts";

const dayMillis = 86_400_000;

// Every aggregate reads the same relation: the filtered requests joined with their active valuation.
const pricedRequests = (db: Database, filter: StatsFilter) =>
  db
    .select({
      conversationId: modelRequests.conversationId,
      provider: modelRequests.provider,
      modelId: modelRequests.modelId,
      route: modelRequests.route,
      requestedAt: modelRequests.requestedAt,
      inputTokens: modelRequests.inputTokens,
      cacheReadTokens: modelRequests.cacheReadTokens,
      cacheWriteTokens:
        sql<number>`${modelRequests.cacheWriteTokens} + ${modelRequests.cacheWrite1hTokens}`.as(
          "cache_write_tokens",
        ),
      outputTokens: modelRequests.outputTokens,
      reasoningTokens: modelRequests.reasoningTokens,
      projectKey: sql<string>`coalesce(${conversations.projectKey}, ${unknownProject})`.as(
        "project_key",
      ),
      projectPath: conversations.projectPath,
      costUsd: sql<string>`case when ${valuations.active} then ${valuations.costUsd} else 0 end`.as(
        "cost_usd",
      ),
      unpriced: sql<boolean>`${valuations.id} is null or ${valuations.costUsd} is null`.as(
        "unpriced",
      ),
    })
    .from(modelRequests)
    .innerJoin(conversations, eq(conversations.id, modelRequests.conversationId))
    .leftJoin(valuations, activeValuation)
    .where(requestConditions(filter))
    .as("priced");

type PricedRequests = ReturnType<typeof pricedRequests>;

const totalCost = (priced: PricedRequests) => sql<string>`coalesce(sum(${priced.costUsd}), 0)`;

const tokenSums = (priced: PricedRequests) => ({
  inputTokens: sum(priced.inputTokens),
  cacheReadTokens: sum(priced.cacheReadTokens),
  cacheWriteTokens: sum(priced.cacheWriteTokens),
  outputTokens: sum(priced.outputTokens),
});

const tokenTotals = (row?: {
  inputTokens: string | null;
  cacheReadTokens: string | null;
  cacheWriteTokens: string | null;
  outputTokens: string | null;
}) => ({
  inputTokens: number(row?.inputTokens),
  cacheReadTokens: number(row?.cacheReadTokens),
  cacheWriteTokens: number(row?.cacheWriteTokens),
  outputTokens: number(row?.outputTokens),
});

const monthlyProration = (
  plan: { monthlyPrice: string; startedOn: string; endedOn: string | null },
  window: { from: Date; to: Date },
): number => {
  const monthlyPrice = number(plan.monthlyPrice);
  const planStart = new Date(`${plan.startedOn}T00:00:00Z`);
  const planEnd =
    plan.endedOn === null
      ? null
      : new Date(new Date(`${plan.endedOn}T00:00:00Z`).getTime() + dayMillis);
  let total = 0;
  const cursor = new Date(Date.UTC(window.from.getUTCFullYear(), window.from.getUTCMonth(), 1));
  while (cursor < window.to) {
    const monthStart = new Date(cursor);
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const daysInMonth = (monthEnd.getTime() - monthStart.getTime()) / dayMillis;
    const start = new Date(
      Math.max(monthStart.getTime(), planStart.getTime(), window.from.getTime()),
    );
    const end = new Date(
      Math.min(
        monthEnd.getTime(),
        planEnd?.getTime() ?? Number.POSITIVE_INFINITY,
        window.to.getTime(),
      ),
    );
    if (end > start)
      total += monthlyPrice * ((end.getTime() - start.getTime()) / dayMillis / daysInMonth);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return total;
};

// Plans billed during the window, per provider, beside the API-equivalent spend of that provider's requests.
export const subscriptionValues = Effect.fn("Stats.subscriptionValues")(function* (
  filter: StatsFilter,
  fallbackFrom: Date | null,
  apiUsdByProvider: ReadonlyMap<ProviderId, number>,
) {
  const db = yield* Db;
  const window = dateWindow(filter);
  const from = window.from ?? fallbackFrom;
  if (from === null) return [];
  const to = window.to ?? new Date();
  const plans = yield* db
    .select({
      provider: subscriptionPlans.provider,
      name: subscriptionPlans.name,
      monthlyPrice: subscriptionPlans.monthlyPrice,
      currency: subscriptionPlans.currency,
      startedOn: subscriptionPlans.startedOn,
      endedOn: subscriptionPlans.endedOn,
    })
    .from(subscriptionPlans)
    .where(
      filter.provider === undefined ? undefined : eq(subscriptionPlans.provider, filter.provider),
    )
    .orderBy(subscriptionPlans.startedOn);
  const byProvider = new Map<ProviderId, { plans: Set<string>; costs: Map<string, number> }>();
  for (const plan of plans) {
    const cost = monthlyProration(plan, { from, to });
    if (cost <= 0) continue;
    const entry = byProvider.get(plan.provider) ?? { plans: new Set(), costs: new Map() };
    entry.plans.add(plan.name);
    entry.costs.set(plan.currency, (entry.costs.get(plan.currency) ?? 0) + cost);
    byProvider.set(plan.provider, entry);
  }
  return [...byProvider]
    .map(([provider, entry]): SubscriptionValue => ({
      provider,
      plans: [...entry.plans],
      planCosts: [...entry.costs].map(([currency, amount]) => ({ currency, amount })),
      apiUsd: apiUsdByProvider.get(provider) ?? 0,
    }))
    .sort((a, b) => b.apiUsd - a.apiUsd);
});

const withoutMachine = ({ machineId: _machineId, ...rest }: StatsFilter): StatsFilter => rest;

export const machineSummaries = Effect.fn("Stats.machines")(function* (filter: StatsFilter) {
  const db = yield* Db;
  const rows = yield* db.select().from(machines).orderBy(machines.name);
  const costs = yield* db
    .select({
      machineId: conversationMachines.machineId,
      costUsd: activeCost,
      conversations: countDistinct(modelRequests.conversationId),
    })
    .from(modelRequests)
    .innerJoin(conversations, eq(conversations.id, modelRequests.conversationId))
    .innerJoin(
      conversationMachines,
      eq(conversationMachines.conversationId, modelRequests.conversationId),
    )
    .leftJoin(valuations, activeValuation)
    .where(requestConditions(withoutMachine(filter)))
    .groupBy(conversationMachines.machineId);
  const byMachine = new Map(costs.map((row) => [row.machineId, row]));
  return rows.map((machine): MachineSummary => ({
    id: machine.id,
    name: machine.name,
    os: machine.os,
    arch: machine.arch,
    agentVersion: machine.agentVersion,
    enrolledAt: machine.enrolledAt.toISOString(),
    lastSeenAt: machine.lastSeenAt?.toISOString() ?? null,
    costUsd: number(byMachine.get(machine.id)?.costUsd),
    conversations: number(byMachine.get(machine.id)?.conversations),
  }));
});

const projectsQuery = (db: Database, filter: StatsFilter) => {
  const priced = pricedRequests(db, filter);
  return db
    .select({
      projectKey: priced.projectKey,
      projectPath: max(priced.projectPath),
      requests: count(),
      conversations: countDistinct(priced.conversationId),
      costUsd: totalCost(priced),
    })
    .from(priced)
    .groupBy(priced.projectKey)
    .orderBy(desc(totalCost(priced)));
};

const overallQueries = (db: Database, filter: StatsFilter) => {
  const priced = pricedRequests(db, filter);
  const window = dateWindow(filter);
  // Messages only need the conversations the filter reaches, not their prices.
  const conversationsInFilter = db
    .select({ id: modelRequests.conversationId })
    .from(modelRequests)
    .innerJoin(conversations, eq(conversations.id, modelRequests.conversationId))
    .where(requestConditions(filter));
  return {
    overall: db
      .select({
        requests: count(),
        conversations: countDistinct(priced.conversationId),
        costUsd: totalCost(priced),
        unpriced: sql`count(*) filter (where ${priced.unpriced})`.mapWith(Number),
        reasoningTokens: sum(priced.reasoningTokens),
        ...tokenSums(priced),
      })
      .from(priced),
    messageCount: db
      .select({ messages: count() })
      .from(messages)
      .where(
        and(
          inArray(messages.conversationId, conversationsInFilter),
          window.from ? gte(messages.createdAt, window.from) : undefined,
          window.to ? lt(messages.createdAt, window.to) : undefined,
        ),
      ),
  };
};

type OverallQueries = ReturnType<typeof overallQueries>;

const overallOf = (results: {
  readonly [K in keyof OverallQueries]: Effect.Success<OverallQueries[K]>;
}): Overall => {
  const [overall] = results.overall;
  return {
    ...tokenTotals(overall),
    reasoningTokens: number(overall?.reasoningTokens),
    costUsd: number(overall?.costUsd),
    unpricedRequests: number(overall?.unpriced),
    requests: number(overall?.requests),
    conversations: number(overall?.conversations),
    messages: number(results.messageCount[0]?.messages),
  };
};

// Browsers still report legacy names such as Asia/Calcutta, which PostgreSQL rejects when its tzdata omits the
// backward links, so days are grouped under the current IANA name. A name outside the IANA list falls back to UTC.
const sqlTimeZone = (timeZone: string | undefined): string => {
  const known = timeZone === undefined ? null : getTimezone(timeZone);
  return known === null ? "UTC" : (known.aliasOf ?? known.name);
};

const dailyQuery = (db: Database, filter: StatsFilter) => {
  const priced = pricedRequests(db, filter);
  const day = sql<string>`to_char(${priced.requestedAt} at time zone ${sqlTimeZone(filter.timeZone)}, 'YYYY-MM-DD')`;
  return (
    db
      .select({
        date: day.as("date"),
        requests: count(),
        conversations: countDistinct(priced.conversationId),
        costUsd: totalCost(priced),
        ...tokenSums(priced),
      })
      .from(priced)
      // The day expression binds the zone as a parameter, and PostgreSQL does not match a GROUP BY that binds it
      // again to the selected one, so rows group by the output column.
      .groupBy(sql`"date"`)
      .orderBy(sql`"date"`)
  );
};

const dayRow = (row: Effect.Success<ReturnType<typeof dailyQuery>>[number]): DayRow => ({
  date: row.date,
  requests: row.requests,
  conversations: row.conversations,
  costUsd: number(row.costUsd),
  ...tokenTotals(row),
});

const dataStartQuery = (db: Database) =>
  db.select({ first: min(modelRequests.requestedAt) }).from(modelRequests);

export const overallStats = Effect.fn("Stats.overall")(function* (filter: StatsFilter) {
  const db = yield* Db;
  return overallOf(yield* Effect.all(overallQueries(db, filter), { concurrency: 2 }));
});

export const dailyStats = Effect.fn("Stats.daily")(function* (filter: StatsFilter) {
  const db = yield* Db;
  const results = yield* Effect.all(
    { daily: dailyQuery(db, filter), dataStart: dataStartQuery(db) },
    { concurrency: 2 },
  );
  const first = results.dataStart[0]?.first ?? null;
  return {
    dataStart: first === null ? null : first.toISOString(),
    daily: results.daily.map(dayRow),
  } satisfies StatsDaily;
});

const projectRow = (row: {
  projectKey: string;
  projectPath: string | null;
  requests: number;
  conversations: number;
  costUsd: string;
}): ProjectRow => ({
  projectKey: row.projectKey,
  projectPath: row.projectPath,
  requests: row.requests,
  conversations: row.conversations,
  costUsd: number(row.costUsd),
});

// The aggregates are independent, so they share the connection pool instead of running one after another.
export const computeStats = Effect.fn("Stats.compute")(function* (filter: StatsFilter) {
  const db = yield* Db;
  const window = dateWindow(filter);
  const priced = pricedRequests(db, filter);
  const costUsd = totalCost(priced);
  const queries = {
    ...overallQueries(db, filter),
    dataStart: dataStartQuery(db),
    byProvider: db
      .select({
        provider: priced.provider,
        requests: count(),
        conversations: countDistinct(priced.conversationId),
        costUsd,
        inputTokens: sum(priced.inputTokens),
        outputTokens: sum(priced.outputTokens),
      })
      .from(priced)
      .groupBy(priced.provider)
      .orderBy(desc(costUsd)),
    byModel: db
      .select({
        modelId: priced.modelId,
        route: priced.route,
        requests: count(),
        costUsd,
        ...tokenSums(priced),
      })
      .from(priced)
      .groupBy(priced.modelId, priced.route)
      .orderBy(desc(costUsd)),
    byProject: projectsQuery(db, filter),
    daily: dailyQuery(db, filter),
    flow: db
      .select({ modelId: priced.modelId, projectKey: priced.projectKey, costUsd })
      .from(priced)
      .groupBy(priced.modelId, priced.projectKey)
      .orderBy(desc(costUsd))
      .limit(40),
    topIds: db
      .select({ id: priced.conversationId, costUsd })
      .from(priced)
      .groupBy(priced.conversationId)
      .orderBy(desc(costUsd))
      .limit(10),
    byMachine: machineSummaries(filter),
  };
  const results = yield* Effect.all(queries, { concurrency: 4 });
  const topConversations = yield* conversationSummaries(results.topIds.map((row) => row.id));
  const dataStart = results.dataStart[0]?.first ?? null;
  const subscriptions = yield* subscriptionValues(
    filter,
    dataStart,
    new Map(results.byProvider.map((row) => [row.provider, number(row.costUsd)])),
  );

  return {
    generatedAt: new Date().toISOString(),
    range:
      window.from && window.to
        ? { from: window.from.toISOString(), to: window.to.toISOString() }
        : null,
    dataStart: dataStart === null ? null : dataStart.toISOString(),
    overall: overallOf(results),
    byProvider: results.byProvider.map((row): ProviderRow => ({
      provider: row.provider,
      requests: row.requests,
      conversations: row.conversations,
      costUsd: number(row.costUsd),
      inputTokens: number(row.inputTokens),
      outputTokens: number(row.outputTokens),
    })),
    byModel: results.byModel.map((row): ModelRow => ({
      modelId: row.modelId,
      route: row.route,
      requests: row.requests,
      costUsd: number(row.costUsd),
      ...tokenTotals(row),
    })),
    byProject: results.byProject.map(projectRow),
    byMachine: results.byMachine,
    daily: results.daily.map(dayRow),
    // Summaries carry lifetime cost; the table is ranked and labelled by cost inside the window.
    topConversations: results.topIds.flatMap((row) => {
      const summary = topConversations.find((candidate) => candidate.id === row.id);
      return summary === undefined ? [] : [{ ...summary, costUsd: number(row.costUsd) }];
    }),
    flow: results.flow.map((row): FlowLink => ({
      modelId: row.modelId,
      projectKey: row.projectKey,
      costUsd: number(row.costUsd),
    })),
    subscriptions,
  } satisfies Stats;
});

export const projectRows = Effect.fn("Stats.projects")(function* (filter: StatsFilter) {
  const db = yield* Db;
  return (yield* projectsQuery(db, filter)).map(projectRow);
});

type DateRange = Pick<StatsFilter, "from" | "to" | "timeZone">;

export const projectDetail = Effect.fn("Stats.projectDetail")(function* (
  projectKey: string,
  range: DateRange,
) {
  const db = yield* Db;
  const [project] = yield* db
    .select({ projectPath: conversations.projectPath })
    .from(conversations)
    .where(projectCondition(projectKey))
    .orderBy(desc(conversations.endedAt))
    .limit(1);
  if (project === undefined) return yield* new NotFound({ entity: "project", id: projectKey });
  const stats = yield* computeStats({ ...range, projectKey });
  const commits = yield* commitsForProject(projectKey);
  return { projectKey, projectPath: project.projectPath, stats, commits } satisfies ProjectDetail;
});

// A machine that has synced for months holds thousands of streams; the page lists the most recent ones.
const streamLimit = 200;

export const machineDetail = Effect.fn("Stats.machineDetail")(function* (
  machineId: string,
  range: DateRange,
) {
  const db = yield* Db;
  const [known] = yield* db
    .select({ id: machines.id })
    .from(machines)
    .where(eq(machines.id, machineId));
  if (known === undefined) return yield* new NotFound({ entity: "machine", id: machineId });
  const results = yield* Effect.all(
    {
      stats: computeStats({ ...range, machineId }),
      streamCount: db
        .select({ n: count() })
        .from(sourceStreams)
        .where(eq(sourceStreams.machineId, machineId)),
      streams: db
        .select({
          provider: sourceStreams.provider,
          streamId: sourceStreams.streamId,
          records:
            sql`(select count(*) from ${sourceRecords} where ${sourceRecords.streamRef} = ${sourceStreams.id})`.mapWith(
              Number,
            ),
          lastSeenAt: sourceStreams.lastSeenAt,
        })
        .from(sourceStreams)
        .where(eq(sourceStreams.machineId, machineId))
        .orderBy(desc(sourceStreams.lastSeenAt))
        .limit(streamLimit),
    },
    { concurrency: 3 },
  );
  const machine = results.stats.byMachine.find((candidate) => candidate.id === machineId);
  if (machine === undefined) return yield* new NotFound({ entity: "machine", id: machineId });
  return {
    machine,
    streamCount: number(results.streamCount[0]?.n),
    streams: results.streams.map((stream) => ({
      ...stream,
      records: number(stream.records),
      lastSeenAt: stream.lastSeenAt.toISOString(),
    })),
    stats: results.stats,
  } satisfies MachineDetail;
});
