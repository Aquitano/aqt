import { quotaStateOf } from "@aqt/turnstash-analysis";
import { providerIds, type ProviderId } from "@aqt/turnstash-core";
import { Cause, Clock, Config, Effect, Layer, Metric, Schedule } from "effect";

import { currentLimitWindows } from "./current-limits.ts";
import { failureSummary } from "./db/errors.ts";

export const quotaMetrics = {
  remaining: Metric.gauge("turnstash_quota_remaining_percent"),
  projected: Metric.gauge("turnstash_quota_projected_remaining_percent"),
  forecast: Metric.gauge("turnstash_quota_forecast_available"),
  reset: Metric.gauge("turnstash_quota_resets_at_seconds"),
  observed: Metric.gauge("turnstash_quota_observed_at_seconds"),
  fresh: Metric.gauge("turnstash_quota_fresh"),
  low: Metric.gauge("turnstash_quota_low"),
  unused: Metric.gauge("turnstash_quota_unused"),
  sampled: Metric.gauge("turnstash_quota_sampled_at_seconds"),
};

export const makeQuotaSampler = Effect.sync(() => {
  const known = new Map<
    string,
    { readonly provider: ProviderId; readonly window_minutes: string }
  >();
  return Effect.fn("Telemetry.sampleQuota")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const current = yield* currentLimitWindows(nowMs);
    const active = new Set<string>();
    for (const provider of providerIds) {
      const windows = current.filter((window) => window.provider === provider);
      const blocked = windows.some(({ open }) => open.usedPercent >= 100);
      for (const { windowMinutes, open } of windows) {
        const key = `${provider}:${windowMinutes}`;
        const attributes = { provider, window_minutes: String(windowMinutes) };
        known.set(key, attributes);
        active.add(key);
        const state = quotaStateOf(open, nowMs, blocked);
        const values = [
          [quotaMetrics.remaining, state.remainingPercent],
          [quotaMetrics.projected, state.canProject ? state.remainingAtReset : 0],
          [quotaMetrics.forecast, Number(state.fresh && state.canProject)],
          [quotaMetrics.reset, open.resetsAtMs / 1000],
          [quotaMetrics.observed, open.lastObservedAtMs / 1000],
          [quotaMetrics.fresh, Number(state.fresh)],
          [quotaMetrics.low, Number(state.low)],
          [quotaMetrics.unused, Number(state.unused)],
          [quotaMetrics.sampled, nowMs / 1000],
        ] as const;
        for (const [metric, value] of values)
          yield* Metric.update(Metric.withAttributes(metric, attributes), value);
      }
    }
    // OTLP keeps exporting registered gauges, so vanished windows must explicitly clear their state.
    for (const [key, attributes] of known) {
      if (active.has(key)) continue;
      for (const metric of Object.values(quotaMetrics))
        yield* Metric.update(
          Metric.withAttributes(metric, attributes),
          metric === quotaMetrics.sampled ? nowMs / 1000 : 0,
        );
    }
  });
});

export const QuotaSamplerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const exporters = yield* Config.String("OTEL_METRICS_EXPORTER").pipe(Config.withDefault(""));
    if (!exporters.toLowerCase().includes("otlp")) return;
    const sample = yield* makeQuotaSampler;
    yield* sample().pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) => Effect.logWarning("quota metric sampling failed", failureSummary(cause)),
      ),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped,
    );
  }),
);
