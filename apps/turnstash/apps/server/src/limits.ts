import { type BuiltLimitWindow, collapseLimitHits, limitWindowsOf } from "@aqt/turnstash-analysis";
import type {
  LimitDrain,
  LimitDrainQuery,
  LimitHitMarker,
  LimitWindow,
  LimitsQuery,
  LimitsReport,
  LimitsOverview,
  PlanCost,
  ProviderLimits,
} from "@aqt/turnstash-api";
import { limitResetToleranceMs, type LimitBatch, type ProviderId } from "@aqt/turnstash-core";
import { and, asc, count, desc, eq, gte, lte, or, sql } from "drizzle-orm";
import { Array as Arr, Clock, Effect } from "effect";

import { Db } from "./db/client.ts";
import {
  conversations,
  limitHits,
  limitSamples,
  modelRequests,
  subscriptionPlans,
  valuations,
} from "./db/schema.ts";
import {
  activeCost,
  activeValuation,
  dateWindow,
  number,
  requestConditions,
  unknownProject,
} from "./filters.ts";
import { scrubOptional } from "./scrub.ts";
import { monthlyProration } from "./stats.ts";

const dayMs = 86_400_000;
const historyDays = 90;
const defaultSpanDays = 14;
// A delta this small is rounding in the provider's whole-percent readings, not a cost per percent.
const minimumPercentForRate = 5;

export const applyLimitBatch = Effect.fn("Limits.applyBatch")(function* (batch: LimitBatch) {
  const db = yield* Db;
  if (batch.readings.length === 0) return { accepted: 0 };
  const inserted = yield* db
    .insert(limitSamples)
    .values(
      batch.readings.map((reading) => ({
        provider: reading.provider,
        windowMinutes: reading.windowMinutes,
        observedAt: new Date(reading.observedAt),
        usedPercent: reading.usedPercent,
        resetsAt: new Date(reading.resetsAt),
        plan: scrubOptional(reading.plan),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: limitSamples.id });
  return { accepted: inserted.length };
});

interface LocatedWindow {
  readonly provider: ProviderId;
  readonly windowMinutes: number;
  readonly built: BuiltLimitWindow;
}

const iso = (ms: number) => new Date(ms).toISOString();

const windowCosts = Effect.fn("Limits.windowCosts")(function* (
  windows: ReadonlyArray<LocatedWindow>,
) {
  const db = yield* Db;
  const costs = new Map<
    number,
    { readonly costUsd: number; readonly deltaCostUsd: number; readonly requests: number }
  >();
  if (windows.length === 0) return costs;
  const spans = windows.map(
    ({ provider, built }, index) =>
      sql`(${index}::int, ${provider}::text, ${iso(built.firstObservedAtMs)}::timestamptz, ${iso(built.lastObservedAtMs)}::timestamptz)`,
  );
  const rows = yield* db.execute<{
    index: number;
    cost_usd: string;
    delta_cost_usd: string;
    requests: number;
  }>(
    sql`
    SELECT span.index, ${activeCost}::text AS cost_usd,
      coalesce(sum(${valuations.costUsd}) FILTER (WHERE ${modelRequests.requestedAt} > span.first_at), 0)::text AS delta_cost_usd,
      count(${modelRequests.id})::int AS requests
    FROM (VALUES ${sql.join(spans, sql`, `)}) AS span(index, provider, first_at, last_at)
    JOIN ${modelRequests} ON ${modelRequests.provider} = span.provider
      AND ${modelRequests.requestedAt} >= span.first_at
      AND ${modelRequests.requestedAt} <= span.last_at
    LEFT JOIN ${valuations} ON ${activeValuation}
    GROUP BY span.index`,
    "objects",
  );
  for (const row of rows)
    costs.set(row.index, {
      costUsd: number(row.cost_usd),
      deltaCostUsd: number(row.delta_cost_usd),
      requests: number(row.requests),
    });
  return costs;
});

interface ChargeableSpan {
  fromMs: number;
  toMs: number;
}

// Each moment of plan cost belongs to the longest window active at that time.
const chargeableSpansOf = (windows: ReadonlyArray<LocatedWindow>) => {
  const spans = new Map<LocatedWindow, Array<ChargeableSpan>>();
  for (const provider of new Set(windows.map((window) => window.provider))) {
    const events = windows
      .filter(
        (window) =>
          window.provider === provider && window.built.startsAtMs < window.built.endedAtMs,
      )
      .flatMap((window) => [
        { atMs: window.built.startsAtMs, window, start: true },
        { atMs: window.built.endedAtMs, window, start: false },
      ])
      .toSorted((a, b) => a.atMs - b.atMs);
    const active = new Set<LocatedWindow>();
    let previousAtMs: number | undefined;
    for (const event of events) {
      if (previousAtMs !== undefined && previousAtMs < event.atMs) {
        let owner: LocatedWindow | undefined;
        for (const window of active)
          if (owner === undefined || window.windowMinutes > owner.windowMinutes) owner = window;
        if (owner !== undefined) {
          const owned = spans.get(owner) ?? [];
          const last = owned.at(-1);
          if (last?.toMs === previousAtMs) last.toMs = event.atMs;
          else owned.push({ fromMs: previousAtMs, toMs: event.atMs });
          spans.set(owner, owned);
        }
      }
      if (event.start) active.add(event.window);
      else active.delete(event.window);
      previousAtMs = event.atMs;
    }
  }
  return spans;
};

const expiredValueOf = (
  built: BuiltLimitWindow,
  plans: ReadonlyArray<typeof subscriptionPlans.$inferSelect>,
  spans: ReadonlyArray<ChargeableSpan>,
): ReadonlyArray<PlanCost> => {
  const unused = (100 - built.usedPercent) / 100;
  const amounts = new Map<string, number>();
  for (const plan of plans) {
    const share = spans.reduce(
      (total, span) =>
        total +
        monthlyProration(plan, {
          from: new Date(span.fromMs),
          to: new Date(span.toMs),
        }),
      0,
    );
    if (share > 0) amounts.set(plan.currency, (amounts.get(plan.currency) ?? 0) + share * unused);
  }
  return [...amounts].map(([currency, amount]) => ({ currency, amount }));
};

const planLabel = (raw: string): string =>
  raw
    .replace(/^default_claude_/, "")
    .replace(/_/g, " ")
    .replace(/^prolite$/, "pro lite");

const limitHistory = Effect.fn("Limits.history")(function* (query: LimitsQuery) {
  const db = yield* Db;
  const nowMs = yield* Clock.currentTimeMillis;
  const span = dateWindow(query);
  const spanFromMs = span.from?.getTime() ?? nowMs - defaultSpanDays * dayMs;
  const spanToMs = span.to?.getTime() ?? Number.POSITIVE_INFINITY;
  const [longest] = yield* db
    .select({ minutes: sql<number>`coalesce(max(${limitSamples.windowMinutes}), 0)::int` })
    .from(limitSamples);
  const contextMs = (longest?.minutes ?? 0) * 60_000;
  const recentSince = new Date(nowMs - historyDays * dayMs - contextMs);
  const since = new Date(Math.min(nowMs - historyDays * dayMs, spanFromMs) - contextMs);
  const until =
    span.to === null ? undefined : new Date(spanToMs + contextMs + limitResetToleranceMs);

  const samples = yield* db
    .select({
      provider: limitSamples.provider,
      windowMinutes: limitSamples.windowMinutes,
      observedAt: limitSamples.observedAt,
      usedPercent: limitSamples.usedPercent,
      resetsAt: limitSamples.resetsAt,
      plan: limitSamples.plan,
    })
    .from(limitSamples)
    .where(
      or(
        and(
          gte(limitSamples.observedAt, since),
          until === undefined ? undefined : lte(limitSamples.observedAt, until),
        ),
        and(
          gte(limitSamples.resetsAt, since),
          until === undefined ? undefined : lte(limitSamples.resetsAt, until),
        ),
        gte(limitSamples.observedAt, recentSince),
        gte(limitSamples.resetsAt, recentSince),
      ),
    )
    .orderBy(asc(limitSamples.observedAt));
  const plans = yield* db.select().from(subscriptionPlans);

  const providers = [...new Set(samples.map((row) => row.provider))].toSorted();
  const located = providers.flatMap((provider) => {
    const own = samples.filter((sample) => sample.provider === provider);
    return [...new Set(own.map((sample) => sample.windowMinutes))].flatMap((windowMinutes) =>
      limitWindowsOf(
        windowMinutes,
        own
          .filter((sample) => sample.windowMinutes === windowMinutes)
          .map((sample) => ({
            observedAtMs: sample.observedAt.getTime(),
            usedPercent: sample.usedPercent,
            resetsAtMs: sample.resetsAt.getTime(),
          })),
        nowMs,
      ).map((built): LocatedWindow => ({ provider, windowMinutes, built })),
    );
  });
  return {
    nowMs,
    spanFromMs,
    spanToMs,
    since,
    until,
    recentSince,
    samples,
    providers,
    located,
    plans,
  };
});

// An early reset grants new quota, so only a window that ran to its reset lost what was left.
const expiredValuesOf = (
  located: ReadonlyArray<LocatedWindow>,
  plans: ReadonlyArray<typeof subscriptionPlans.$inferSelect>,
) => {
  const chargeable = chargeableSpansOf(located);
  return new Map(
    located.map(
      (window) =>
        [
          window,
          window.built.outcome === "reset"
            ? expiredValueOf(
                window.built,
                plans.filter((plan) => plan.provider === window.provider),
                chargeable.get(window) ?? [],
              )
            : [],
        ] as const,
    ),
  );
};

export const limitsReport = Effect.fn("Limits.report")(function* (query: LimitsQuery) {
  const db = yield* Db;
  const { nowMs, spanFromMs, spanToMs, since, until, recentSince, samples, located, plans } =
    yield* limitHistory(query);
  const hits = yield* db
    .select({
      provider: limitHits.provider,
      occurredAt: limitHits.occurredAt,
      windowMinutes: limitHits.windowMinutes,
      message: limitHits.message,
    })
    .from(limitHits)
    .where(
      or(
        and(
          gte(limitHits.occurredAt, since),
          until === undefined ? undefined : lte(limitHits.occurredAt, until),
        ),
        gte(limitHits.occurredAt, recentSince),
      ),
    );
  const providers = [...new Set([...samples, ...hits].map((row) => row.provider))].toSorted();
  const expired = expiredValuesOf(located, plans);
  const costs = yield* windowCosts(located);
  const views = located.map((window, index) => {
    const { provider, windowMinutes, built } = window;
    const cost = costs.get(index) ?? { costUsd: 0, deltaCostUsd: 0, requests: 0 };
    const rose = built.usedPercent - built.firstUsedPercent;
    const inSpan = built.endedAtMs >= spanFromMs && built.startsAtMs < spanToMs;
    const view: LimitWindow = {
      windowMinutes,
      startsAt: iso(built.startsAtMs),
      resetsAt: iso(built.resetsAtMs),
      endedAt: iso(built.endedAtMs),
      outcome: built.outcome,
      firstObservedAt: iso(built.firstObservedAtMs),
      lastObservedAt: iso(built.lastObservedAtMs),
      firstUsedPercent: built.firstUsedPercent,
      usedPercent: built.usedPercent,
      costUsd: cost.costUsd,
      requests: cost.requests,
      costPerPercentUsd:
        rose >= minimumPercentForRate && cost.deltaCostUsd > 0 ? cost.deltaCostUsd / rose : null,
      expiredValue: expired.get(window) ?? [],
      points:
        inSpan || built.outcome === "open"
          ? built.points.map((point) => ({ at: iso(point.atMs), usedPercent: point.usedPercent }))
          : [],
    };
    return { provider, windowMinutes, view };
  });

  const report: LimitsReport = {
    generatedAt: iso(nowMs),
    providers: providers.map((provider): ProviderLimits => {
      const own = views.filter((entry) => entry.provider === provider);
      const minutes = [...new Set(own.map((entry) => entry.windowMinutes))].toSorted(
        (a, b) => b - a,
      );
      const latestPlan = samples.findLast(
        (sample) => sample.provider === provider && sample.plan !== null,
      )?.plan;
      return {
        provider,
        plan: latestPlan === undefined || latestPlan === null ? null : planLabel(latestPlan),
        series: minutes.map((windowMinutes) => ({
          windowMinutes,
          windows: own
            .filter((entry) => entry.windowMinutes === windowMinutes)
            .map((entry) => entry.view),
        })),
        hits: collapseLimitHits(
          hits
            .filter((hit) => hit.provider === provider)
            .map((hit) => ({
              atMs: hit.occurredAt.getTime(),
              windowMinutes: hit.windowMinutes,
              message: hit.message,
            })),
        ).map((hit): LimitHitMarker => ({
          at: iso(hit.atMs),
          windowMinutes: hit.windowMinutes,
          message: hit.message,
          count: hit.count,
        })),
      };
    }),
  };
  return report;
});

export const limitsOverview = Effect.fn("Limits.overview")(function* (query: LimitsQuery) {
  const { nowMs, spanFromMs, spanToMs, providers, located, plans } = yield* limitHistory(query);
  const expired = expiredValuesOf(located, plans);
  return {
    generatedAt: iso(nowMs),
    providers: providers.map((provider) => {
      const own = located.filter((window) => window.provider === provider);
      const latest = new Map<number, BuiltLimitWindow>();
      const totals = new Map<string, number>();
      for (const window of own) {
        latest.set(window.windowMinutes, window.built);
        if (window.built.resetsAtMs < spanFromMs || window.built.resetsAtMs >= spanToMs) continue;
        for (const { currency, amount } of expired.get(window) ?? [])
          totals.set(currency, (totals.get(currency) ?? 0) + amount);
      }
      return {
        provider,
        series: [...latest]
          .toSorted(([a], [b]) => b - a)
          .map(([windowMinutes, window]) => ({
            windowMinutes,
            windows: [
              {
                outcome: window.outcome,
                usedPercent: window.usedPercent,
                resetsAt: iso(window.resetsAtMs),
              },
            ],
          })),
        expiredValue: [...totals].map(([currency, amount]) => ({ currency, amount })),
      };
    }),
  } satisfies LimitsOverview;
});

const conversationLimit = 12;

export const limitDrain = Effect.fn("Limits.drain")(function* (query: LimitDrainQuery) {
  const db = yield* Db;
  const where = requestConditions(query);
  const cost = sql<string>`${activeCost}`;
  const requests = count(modelRequests.id);
  const conversationRows = yield* db
    .select({
      id: conversations.id,
      title: conversations.title,
      projectKey: conversations.projectKey,
      requests,
      costUsd: cost,
    })
    .from(modelRequests)
    .innerJoin(conversations, eq(conversations.id, modelRequests.conversationId))
    .leftJoin(valuations, activeValuation)
    .where(where)
    .groupBy(conversations.id)
    .orderBy(desc(cost))
    .limit(conversationLimit);
  const projectKey =
    sql<string>`coalesce(${conversations.projectKey}, ${unknownProject})`.inlineParams();
  const projectRows = yield* db
    .select({
      projectKey,
      projectPath: sql<string | null>`max(${conversations.projectPath})`,
      requests,
      costUsd: cost,
    })
    .from(modelRequests)
    .innerJoin(conversations, eq(conversations.id, modelRequests.conversationId))
    .leftJoin(valuations, activeValuation)
    .where(where)
    .groupBy(projectKey)
    .orderBy(desc(cost));
  const drain: LimitDrain = {
    costUsd: Arr.reduce(projectRows, 0, (total, row) => total + number(row.costUsd)),
    requests: Arr.reduce(projectRows, 0, (total, row) => total + row.requests),
    conversations: conversationRows.map((row) => ({
      id: row.id,
      title: row.title,
      projectKey: row.projectKey,
      requests: row.requests,
      costUsd: number(row.costUsd),
    })),
    projects: projectRows.map((row) => ({
      projectKey: row.projectKey,
      projectPath: row.projectPath,
      requests: row.requests,
      costUsd: number(row.costUsd),
    })),
  };
  return drain;
});
