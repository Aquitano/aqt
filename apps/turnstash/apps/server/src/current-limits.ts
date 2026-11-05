import {
  limitWindowsOf,
  quotaObservationMaxAgeMs,
  type LimitObservation,
} from "@aqt/turnstash-analysis";
import type { CurrentLimitsReport } from "@aqt/turnstash-api";
import { limitResetToleranceMs, providerIds, type ProviderId } from "@aqt/turnstash-core";
import { asc, gte, or } from "drizzle-orm";
import { Clock, Effect } from "effect";

import { Db } from "./db/client.ts";
import { limitSamples } from "./db/schema.ts";

export const currentLimitWindows = Effect.fn("Limits.currentWindows")(function* (nowMs: number) {
  const db = yield* Db;
  const samples = yield* db
    .select({
      provider: limitSamples.provider,
      windowMinutes: limitSamples.windowMinutes,
      observedAt: limitSamples.observedAt,
      resetsAt: limitSamples.resetsAt,
      usedPercent: limitSamples.usedPercent,
    })
    .from(limitSamples)
    .where(
      or(
        gte(limitSamples.resetsAt, new Date(nowMs - limitResetToleranceMs)),
        gte(limitSamples.observedAt, new Date(nowMs - quotaObservationMaxAgeMs)),
      ),
    )
    .orderBy(asc(limitSamples.observedAt));
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
