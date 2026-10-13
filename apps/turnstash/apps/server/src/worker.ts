import { Cause, Clock, Effect, Layer, Metric, Ref, Schedule } from "effect";

import { ServerConfig } from "./config.ts";
import { failureSummary } from "./db/errors.ts";
import { hasDueConversations, normalizeDirty, queueStale } from "./normalize.ts";
import { workerItems, workerPassMillis } from "./telemetry.ts";
import { autoRefreshPricing, hasCatalogWork, pruneValuations, valuePending } from "./valuation.ts";

const normalizeBatch = 20;
const valueBatch = 2000;

export const workOnce = Effect.fn("Worker.once")(function* () {
  const started = yield* Clock.currentTimeMillis;
  const normalized = yield* normalizeDirty(normalizeBatch);
  const valued = yield* valuePending(valueBatch);
  yield* Metric.update(workerPassMillis, (yield* Clock.currentTimeMillis) - started);
  yield* Metric.update(Metric.withAttributes(workerItems, { kind: "normalized" }), normalized);
  yield* Metric.update(Metric.withAttributes(workerItems, { kind: "valued" }), valued);
  return { normalized, valued };
});

// Idle polls run every couple of seconds, so they are checked untraced and only a pass with work is traced.
const hasWork = Effect.gen(function* () {
  return (yield* hasDueConversations()) || (yield* hasCatalogWork());
}).pipe(Effect.withTracerEnabled(false));

// A pass that filled its batch probably left work behind, so the next one starts at once instead of after the
// idle interval; a reprocess otherwise spent most of its time sleeping. Unpriced requests only appear in a pass
// that normalizes and a completed drain prices them all, so polling skips the full-history unpriced check; after
// startup or a failed pass the drain runs without it.
const drain = (settled: Ref.Ref<boolean>) =>
  Effect.gen(function* () {
    if ((yield* Ref.get(settled)) && !(yield* hasWork)) return;
    yield* Ref.set(settled, false);
    yield* workOnce().pipe(
      Effect.repeat({
        while: (pass) => pass.normalized >= normalizeBatch || pass.valued >= valueBatch,
      }),
    );
    yield* Ref.set(settled, true);
  });

export const WorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const stale = yield* queueStale();
    if (stale > 0)
      yield* Effect.logInfo("queued conversations for re-normalization", { count: stale });
    const pruned = yield* pruneValuations();
    if (pruned > 0) yield* Effect.logInfo("pruned valuations of old catalogs", { count: pruned });
    const settled = yield* Ref.make(false);
    yield* drain(settled).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) => Effect.logError("worker pass failed", failureSummary(cause)),
      ),
      Effect.repeat(Schedule.spaced(`${config.workerIntervalMillis} millis`)),
      Effect.forkScoped,
    );
  }),
);

const logUpstreamFailure = (error: { readonly message: string }) =>
  Effect.logWarning("pricing refresh failed", { message: error.message });

export const PricingRefreshLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const { pricingRefreshHours } = yield* ServerConfig;
    if (pricingRefreshHours === 0) return;
    yield* autoRefreshPricing().pipe(
      Effect.tap((repriced) =>
        repriced.length === 0
          ? Effect.void
          : Effect.logInfo("repricing with refreshed LiteLLM catalog", { models: repriced }),
      ),
      Effect.catchTags({
        HttpClientError: logUpstreamFailure,
        SchemaError: logUpstreamFailure,
        TimeoutError: logUpstreamFailure,
      }),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) => Effect.logError("pricing refresh failed", failureSummary(cause)),
      ),
      Effect.repeat(Schedule.spaced(`${pricingRefreshHours} hours`)),
      Effect.forkScoped,
    );
  }),
);
