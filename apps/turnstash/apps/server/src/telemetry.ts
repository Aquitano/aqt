import { providerIds } from "@aqt/turnstash-core";
import { sql } from "drizzle-orm";
import { Cause, Config, Effect, Layer, Metric, Schedule } from "effect";
import { Otlp, OtlpSerialization } from "effect/observability";

import { serverVersion } from "./config.ts";
import { Db } from "./db/client.ts";
import { failureSummary } from "./db/errors.ts";

// Off unless the deployment sets OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_{TRACES,LOGS,METRICS}_EXPORTER=otlp.
// Logs still go to the console as well, so `docker logs` keeps working.
export const TelemetryLive = Otlp.layerFromConfig({
  resource: { serviceName: "turnstash-server", serviceVersion: serverVersion },
  loggerMergeWithExisting: true,
}).pipe(Layer.provide(OtlpSerialization.layerJson));

export const recordsIngested = Metric.counter("turnstash.ingest.records", {
  description: "Records received from agents, by machine, provider and outcome",
  incremental: true,
});

export const batchesIngested = Metric.counter("turnstash.ingest.batches", {
  description: "Batches accepted from agents, by machine",
  incremental: true,
});

export const normalizeFailures = Metric.counter("turnstash.normalize.failures", {
  description: "Conversations that failed to normalize and were put into backoff",
  incremental: true,
});

export const workerPassMillis = Metric.histogram("turnstash.worker.pass.duration", {
  description: "Duration of one worker pass in milliseconds",
  boundaries: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000],
});

export const workerItems = Metric.counter("turnstash.worker.items", {
  description: "Conversations normalized and requests priced by the worker, by kind",
  incremental: true,
});

const queueDepth = Metric.gauge("turnstash.queue.depth", {
  description: "Dirty conversations waiting for the worker, by state (due or backoff)",
});
const archiveRows = Metric.gauge("turnstash.archive.rows", {
  description: "Rows in the archive, by table",
});
const unpricedRequests = Metric.gauge("turnstash.requests.unpriced", {
  description: "Requests without an active valuation",
});
const machineSyncAge = Metric.gauge("turnstash.machine.sync_age", {
  description: "Seconds since each machine last contacted the server",
});
const costUsd = Metric.gauge("turnstash.cost.usd", {
  description: "API-equivalent cost so far in the current UTC day or month, by provider and period",
});

interface Totals extends Record<string, unknown> {
  readonly due: string;
  readonly backoff: string;
  readonly unpriced: string;
  readonly conversations: string;
  readonly messages: string;
  readonly requests: string;
  readonly valuations: string;
}

const sampleGauges = Effect.fn("Telemetry.sampleGauges")(function* () {
  const db = yield* Db;
  const [totals] = yield* db.execute<Totals>(
    sql`select
      (select count(*) from dirty_conversations where marked_at <= now()) as due,
      (select count(*) from dirty_conversations where marked_at > now()) as backoff,
      (select count(*) from model_requests r where not exists (
        select 1 from valuations v where v.request_id = r.id and v.active)) as unpriced,
      (select count(*) from conversations) as conversations,
      (select count(*) from messages) as messages,
      (select count(*) from model_requests) as requests,
      (select count(*) from valuations) as valuations`,
    "objects",
  );
  if (totals !== undefined) {
    yield* Metric.update(Metric.withAttributes(queueDepth, { state: "due" }), Number(totals.due));
    yield* Metric.update(
      Metric.withAttributes(queueDepth, { state: "backoff" }),
      Number(totals.backoff),
    );
    yield* Metric.update(unpricedRequests, Number(totals.unpriced));
    for (const table of ["conversations", "messages", "requests", "valuations"] as const)
      yield* Metric.update(Metric.withAttributes(archiveRows, { table }), Number(totals[table]));
  }
  const machines = yield* db.execute<{ name: string; age: string | null }>(
    sql`select name, extract(epoch from now() - last_seen_at)::bigint as age from machines`,
    "objects",
  );
  for (const machine of machines)
    if (machine.age !== null)
      yield* Metric.update(
        Metric.withAttributes(machineSyncAge, { machine: machine.name }),
        Number(machine.age),
      );
  const costs = yield* db.execute<{ provider: string; today: string; month: string }>(
    sql`select r.provider,
        coalesce(sum(v.cost_usd) filter (where r.requested_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'), 0) as today,
        coalesce(sum(v.cost_usd), 0) as month
      from model_requests r
      left join valuations v on v.request_id = r.id and v.active
      where r.requested_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
      group by r.provider`,
    "objects",
  );
  const costsByProvider = new Map(costs.map((cost) => [cost.provider, cost]));
  for (const provider of providerIds) {
    const cost = costsByProvider.get(provider);
    yield* Metric.update(
      Metric.withAttributes(costUsd, { provider, period: "day" }),
      Number(cost?.today ?? 0),
    );
    yield* Metric.update(
      Metric.withAttributes(costUsd, { provider, period: "month" }),
      Number(cost?.month ?? 0),
    );
  }
});

// The gauges cost a few counting queries, so they are sampled only when metrics are exported at all.
export const GaugeSamplerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const exporters = yield* Config.String("OTEL_METRICS_EXPORTER").pipe(Config.withDefault(""));
    if (!exporters.toLowerCase().includes("otlp")) return;
    yield* sampleGauges().pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) => Effect.logWarning("metric sampling failed", failureSummary(cause)),
      ),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped,
    );
  }),
);
