import { limitWindowsOf, type LimitObservation } from "@aqt/turnstash-analysis";
import type { CurrentLimitsReport } from "@aqt/turnstash-api";
import { limitResetToleranceMs, providerIds, type ProviderId } from "@aqt/turnstash-core";
import { and, eq, gt, gte, lt, or } from "drizzle-orm";
import { Clock, Effect } from "effect";

import { Db } from "./db/client.ts";
import { limitSamples } from "./db/schema.ts";

export const currentLimitWindows = Effect.fn("Limits.currentWindows")(function* (nowMs: number) {
  const db = yield* Db;
  const columns = {
    provider: limitSamples.provider,
    windowMinutes: limitSamples.windowMinutes,
    observedAt: limitSamples.observedAt,
    resetsAt: limitSamples.resetsAt,
    usedPercent: limitSamples.usedPercent,
  };
  let batch = yield* db
    .select(columns)
    .from(limitSamples)
    .where(gte(limitSamples.resetsAt, new Date(nowMs - limitResetToleranceMs)));
  const samples = [...batch];
  // Reset jitter can form a chain longer than the tolerance. Follow its indexed predecessors
  // until a gap proves that an earlier observation cannot belong to a current draft.
  while (batch.length > 0) {
    const earliest = new Map<string, (typeof batch)[number]>();
    for (const sample of batch) {
      const key = `${sample.provider}:${sample.windowMinutes}`;
      const previous = earliest.get(key);
      if (previous === undefined || sample.resetsAt < previous.resetsAt) earliest.set(key, sample);
    }
    batch = yield* db
      .select(columns)
      .from(limitSamples)
      .where(
        or(
          ...[...earliest.values()].map((sample) =>
            and(
              eq(limitSamples.provider, sample.provider),
              eq(limitSamples.windowMinutes, sample.windowMinutes),
              gt(
                limitSamples.resetsAt,
                new Date(sample.resetsAt.getTime() - limitResetToleranceMs),
              ),
              lt(limitSamples.resetsAt, sample.resetsAt),
            ),
          ),
        ),
      );
    for (const sample of batch) samples.push(sample);
  }
  const groups = new Map<
    string,
    { provider: ProviderId; windowMinutes: number; observations: Array<LimitObservation> }
  >();
  for (const sample of samples) {
    const key = `${sample.provider}:${sample.windowMinutes}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { provider: sample.provider, windowMinutes: sample.windowMinutes, observations: [] };
      groups.set(key, group);
    }
    group.observations.push({
      observedAtMs: sample.observedAt.getTime(),
      resetsAtMs: sample.resetsAt.getTime(),
      usedPercent: sample.usedPercent,
    });
  }
  return [...groups.values()].flatMap(({ provider, windowMinutes, observations }) => {
    const open = limitWindowsOf(windowMinutes, observations, nowMs).findLast(
      (window) => window.outcome === "open",
    );
    return open === undefined ? [] : [{ provider, windowMinutes, open }];
  });
});

const iso = (ms: number) => new Date(ms).toISOString();

export const currentLimitsReport = Effect.fn("Limits.currentReport")(function* () {
  const nowMs = yield* Clock.currentTimeMillis;
  const windows = yield* currentLimitWindows(nowMs);
  return {
    generatedAt: iso(nowMs),
    providers: providerIds.flatMap((provider) => {
      const own = windows
        .filter((window) => window.provider === provider)
        .toSorted((a, b) => b.windowMinutes - a.windowMinutes);
      if (own.length === 0) return [];
      return [
        {
          provider,
          windows: own.map(({ windowMinutes, open }) => {
            // Alert evaluation permits a browser clock up to a minute behind the report.
            const anchor = open.points.findLastIndex((point) => point.atMs <= nowMs - 3_660_000);
            return {
              windowMinutes,
              startsAt: iso(open.startsAtMs),
              resetsAt: iso(open.resetsAtMs),
              endedAt: iso(open.endedAtMs),
              outcome: open.outcome,
              firstObservedAt: iso(open.firstObservedAtMs),
              lastObservedAt: iso(open.lastObservedAtMs),
              firstUsedPercent: open.firstUsedPercent,
              usedPercent: open.usedPercent,
              points: open.points
                .slice(Math.max(0, anchor))
                .map((point) => ({ at: iso(point.atMs), usedPercent: point.usedPercent })),
            };
          }),
        },
      ];
    }),
  } satisfies CurrentLimitsReport;
});
