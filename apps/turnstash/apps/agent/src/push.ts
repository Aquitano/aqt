import { Api } from "@aqt/turnstash-api";
import { batchLimits, type IngestBatch, type MachineId, type Tombstone } from "@aqt/turnstash-core";
import { Effect, Option, type Redacted, Schedule } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

import { AgentState } from "./state.ts";

const requestTimeout = "2 minutes";
const retryPolicy = Schedule.exponential("500 millis").pipe(Schedule.jittered);

// Retrying resends the request, so callers whose request is not idempotent (enrolment) or who
// want a fast answer (doctor) turn it off.
export const apiClientFor = (
  serverUrl: string,
  token: Redacted.Redacted<string>,
  options: { readonly retry?: boolean } = {},
) =>
  HttpApiClient.make(Api, {
    baseUrl: serverUrl,
    transformClient: (client) => {
      const timed = client.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
        HttpClient.transform((response, request) =>
          response.pipe(
            Effect.timeoutOrElse({
              duration: requestTimeout,
              orElse: () =>
                Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      description: `no response within ${requestTimeout}`,
                    }),
                  }),
                ),
            }),
          ),
        ),
      );
      return options.retry === false
        ? timed
        : timed.pipe(HttpClient.retryTransient({ schedule: retryPolicy, times: 5 }));
    },
  });

export type ApiClient = Effect.Success<ReturnType<typeof apiClientFor>>;

export interface PushSummary {
  readonly batches: number;
  readonly accepted: number;
  readonly duplicates: number;
  readonly replaced: number;
  readonly refused: number;
  readonly requeued: number;
  readonly tombstones: number;
}

export interface PushProgress {
  readonly sent: number;
  readonly total: number;
}

const tombstonesSinceKey = "tombstones_since";

// The server's own BadRequest (wrong token, machine mismatch) decodes into a typed error and stays a
// failure. These statuses without that body mean a proxy or the payload schema turned the records down.
const refusedStatuses: ReadonlySet<number> = new Set([400, 413, 422]);

type PushBatchError = Effect.Error<ReturnType<ApiClient["ingest"]["pushBatch"]>>;

const isRefusal = (error: PushBatchError): boolean =>
  HttpClientError.isHttpClientError(error) && refusedStatuses.has(error.response?.status ?? 0);

const newestDeletion = (
  tombstones: ReadonlyArray<Tombstone>,
  since: string | null,
): string | null =>
  tombstones.reduce<string | null>(
    (newest, tombstone) =>
      newest === null || Date.parse(tombstone.deletedAt) > Date.parse(newest)
        ? tombstone.deletedAt
        : newest,
    since,
  );

const batchesInFlight = 2;

export const push = Effect.fn("Agent.push")(function* (
  client: ApiClient,
  identity: { readonly machineId: MachineId; readonly agentVersion: string },
  options: { readonly onProgress?: (progress: PushProgress) => Effect.Effect<void> } = {},
) {
  const state = yield* AgentState.Service;
  // A refusal by an older agent may have been this agent's bug or a server since upgraded, so a new
  // version gets one more try at everything an earlier one set aside.
  const requeued = yield* state.retryRefused(identity.agentVersion);
  const total = yield* state.pendingCount();
  let sent = 0;
  const reportSent = (records: number) => {
    sent += records;
    return options.onProgress?.({ sent, total }) ?? Effect.void;
  };
  const summary = {
    batches: 0,
    accepted: 0,
    duplicates: 0,
    replaced: 0,
    refused: 0,
    requeued,
    tombstones: 0,
  };
  // A refused batch is split in half until the record the server turns down is alone in its batch.
  let recordLimit: number = batchLimits.maxRecords;
  const send = Effect.fn("Agent.send")(function* (batch: IngestBatch) {
    const result = yield* client.ingest.pushBatch({ payload: batch }).pipe(
      Effect.map(Option.some),
      Effect.catchIf(isRefusal, () => Effect.succeedNone),
    );
    if (Option.isNone(result)) {
      if (batch.records.length > 1) {
        recordLimit = Math.min(recordLimit, Math.ceil(batch.records.length / 2));
        yield* state.releaseBatch(batch.batchId);
      } else {
        yield* state.rejectBatch(batch.batchId, identity.agentVersion);
        recordLimit = batchLimits.maxRecords;
        summary.refused += 1;
        yield* reportSent(1);
      }
      return;
    }
    yield* state.markDelivered(batch.batchId);
    yield* reportSent(batch.records.length);
    summary.batches += 1;
    summary.accepted += result.value.accepted;
    summary.duplicates += result.value.duplicates;
    summary.replaced += result.value.replaced;
  });
  // Batches interrupted by an earlier run, or in flight in a concurrent one, are resent one at a time
  // before new ones are claimed, so the concurrent workers can never pick up the same batch id.
  while (true) {
    const pending = yield* state.pendingBatchId();
    if (pending === null) break;
    const batch = yield* state.resumeBatch(pending, identity);
    if (batch !== null) yield* send(batch);
  }
  const worker = Effect.gen(function* () {
    while (true) {
      const batch = yield* state.claimBatch(
        { batchId: crypto.randomUUID(), ...identity },
        { maxRecords: recordLimit },
      );
      if (batch.records.length === 0) return;
      yield* send(batch);
    }
  });
  yield* Effect.all(
    Array.from({ length: batchesInFlight }, () => worker),
    { concurrency: batchesInFlight, discard: true },
  );
  const since = yield* state.getMeta(tombstonesSinceKey);
  const tombstones = yield* client.ingest.tombstones({ query: since === null ? {} : { since } });
  summary.tombstones = yield* state.addTombstones(tombstones);
  const newest = newestDeletion(tombstones, since);
  if (newest !== null && newest !== since) yield* state.setMeta(tombstonesSinceKey, newest);
  return summary satisfies PushSummary;
});
