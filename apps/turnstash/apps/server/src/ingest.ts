import { BadRequest } from "@aqt/turnstash-api";
import type {
  IngestBatch,
  IngestResult,
  MachineId,
  ProviderId,
  StreamId,
  Tombstone,
  WireRecord,
} from "@aqt/turnstash-core";
import { ConversationKey } from "@aqt/turnstash-core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect, Metric, Option } from "effect";

import { setRecordBlobs } from "./blobs.ts";
import { ServerConfig } from "./config.ts";
import { lockConversations } from "./conversation-locks.ts";
import { Db, inTransaction } from "./db/client.ts";
import {
  dirtyConversations,
  ingestBatches,
  machines,
  sourceRecords,
  sourceStreams,
  tombstones,
} from "./db/schema.ts";
import { excluded } from "./db/sql.ts";
import { Normalizers, storedRecordOf } from "./registry.ts";
import { scrubText } from "./scrub.ts";
import { batchesIngested, recordsIngested } from "./telemetry.ts";

type RecordOutcome = "accepted" | "replaced" | "duplicate";

const streamKey = (provider: string, streamId: string) => `${provider}\u0000${streamId}`;
const recordRef = (streamRef: number, recordKey: string) => `${streamRef}\u0000${recordKey}`;

// New records may be exactly what a failing conversation was missing, so a fresh mark also clears its backoff.
// The mark comes due once the conversation stops receiving batches. Otherwise a first sync rebuilds a long
// session from all its records after every batch.
export const markDirty = Effect.fn("Ingest.markDirty")(function* (
  keys: ReadonlyArray<{ readonly provider: ProviderId; readonly conversationKey: string }>,
) {
  if (keys.length === 0) return;
  const db = yield* Db;
  const { normalizeSettleMillis } = yield* ServerConfig;
  const due = sql`statement_timestamp() + make_interval(secs => ${normalizeSettleMillis / 1000})`;
  yield* db
    .insert(dirtyConversations)
    .values(
      keys.map((key) => ({
        provider: key.provider,
        conversationKey: key.conversationKey,
        markedAt: due,
      })),
    )
    .onConflictDoUpdate({
      target: [dirtyConversations.provider, dirtyConversations.conversationKey],
      set: { markedAt: due, attempts: 0 },
    });
});

export const applyBatch = Effect.fn("Ingest.applyBatch")(function* (
  machineId: MachineId,
  batch: IngestBatch,
) {
  const normalizers = yield* Normalizers;

  const streams = new Map<string, { provider: ProviderId; streamId: StreamId }>();
  for (const record of batch.records)
    streams.set(streamKey(record.provider, record.streamId), {
      provider: record.provider,
      streamId: record.streamId,
    });

  const conversationKeyOf = (record: WireRecord): string | null =>
    Option.getOrNull(
      normalizers[record.provider].conversationKeyOf(record.streamId, record.payload),
    );
  const providers = [...new Set(batch.records.map((record) => record.provider))];
  const conversationKeys = batch.records.flatMap((record) => {
    const conversationKey = conversationKeyOf(record);
    return conversationKey === null ? [] : [{ provider: record.provider, conversationKey }];
  });

  const outcome = yield* inTransaction(
    Effect.gen(function* () {
      const tx = yield* Db;
      const claimed = yield* tx
        .insert(ingestBatches)
        .values({ id: batch.batchId, machineId, accepted: 0, duplicates: 0, replaced: 0 })
        .onConflictDoNothing({ target: ingestBatches.id })
        .returning({ id: ingestBatches.id });
      if (claimed.length === 0) {
        const [previous] = yield* tx
          .select()
          .from(ingestBatches)
          .where(eq(ingestBatches.id, batch.batchId));
        if (previous === undefined) return yield* Effect.die("batch acknowledgement disappeared");
        if (previous.machineId !== machineId)
          return yield* new BadRequest({ message: "batchId belongs to another machine" });
        return {
          result: {
            batchId: batch.batchId,
            accepted: previous.accepted,
            duplicates: previous.duplicates,
            replaced: previous.replaced,
          } satisfies IngestResult,
          tally: null,
        };
      }
      yield* lockConversations(conversationKeys);
      const deleted =
        providers.length === 0
          ? []
          : yield* tx
              .select({
                provider: tombstones.provider,
                conversationKey: tombstones.conversationKey,
              })
              .from(tombstones)
              .where(inArray(tombstones.provider, providers));
      const isTombstoned = (provider: ProviderId, conversationKey: string | null) =>
        conversationKey !== null &&
        deleted.some((row) => row.provider === provider && row.conversationKey === conversationKey);
      let accepted = 0;
      let duplicates = 0;
      let replaced = 0;
      const tally = new Map<
        string,
        { provider: ProviderId; outcome: RecordOutcome; count: number }
      >();
      const note = (provider: ProviderId, outcome: RecordOutcome) => {
        if (outcome === "accepted") accepted += 1;
        else if (outcome === "replaced") replaced += 1;
        else duplicates += 1;
        const key = `${provider}\u0000${outcome}`;
        const entry = tally.get(key) ?? { provider, outcome, count: 0 };
        tally.set(key, { ...entry, count: entry.count + 1 });
      };
      const dirty = new Map<string, { provider: ProviderId; conversationKey: string }>();
      const touch = (provider: ProviderId, conversationKey: string | null) => {
        if (conversationKey !== null)
          dirty.set(`${provider}\u0000${conversationKey}`, { provider, conversationKey });
      };

      // One statement per step for the whole batch: most streams carry a single record, so per-stream round trips
      // dominated ingest while the conversation locks were held.
      const streamRows =
        streams.size === 0
          ? []
          : yield* tx
              .insert(sourceStreams)
              .values([...streams.values()].map((stream) => ({ machineId, ...stream })))
              .onConflictDoUpdate({
                target: [sourceStreams.machineId, sourceStreams.provider, sourceStreams.streamId],
                set: { lastSeenAt: sql`now()` },
              })
              .returning({
                id: sourceStreams.id,
                provider: sourceStreams.provider,
                streamId: sourceStreams.streamId,
              });
      const streamRefs = new Map(
        streamRows.map((row) => [streamKey(row.provider, row.streamId), row.id]),
      );
      // Rows matching a stream and a key from two different records are fetched too and never looked up.
      const existing =
        streamRows.length === 0
          ? []
          : yield* tx
              .select({
                streamRef: sourceRecords.streamRef,
                recordKey: sourceRecords.recordKey,
                contentHash: sourceRecords.contentHash,
                conversationKey: sourceRecords.conversationKey,
                observedAt: sourceRecords.observedAt,
              })
              .from(sourceRecords)
              .where(
                and(
                  inArray(sourceRecords.streamRef, [...streamRefs.values()]),
                  inArray(sourceRecords.recordKey, [
                    ...new Set(batch.records.map((record) => record.recordKey)),
                  ]),
                ),
              );
      const known = new Map(existing.map((row) => [recordRef(row.streamRef, row.recordKey), row]));

      const pending = new Map<string, typeof sourceRecords.$inferInsert>();
      const pendingBlobs = new Map<string, ReadonlyMap<string, Buffer>>();
      for (const record of batch.records) {
        const streamRef = streamRefs.get(streamKey(record.provider, record.streamId));
        if (streamRef === undefined) continue;
        const ref = recordRef(streamRef, record.recordKey);
        const previousRow = known.get(ref);
        const observedAt = new Date(record.observedAt);
        // Agents push batches concurrently, so an older version of a record can arrive after a newer one.
        if (
          previousRow !== undefined &&
          (previousRow.contentHash === record.contentHash || previousRow.observedAt > observedAt)
        ) {
          note(record.provider, "duplicate");
          continue;
        }
        const conversationKey = conversationKeyOf(record);
        if (isTombstoned(record.provider, conversationKey)) {
          note(record.provider, "duplicate");
          continue;
        }
        const stored = storedRecordOf(
          normalizers[record.provider],
          record.streamId,
          record.payload,
        );
        const row = {
          streamRef,
          provider: record.provider,
          recordKey: record.recordKey,
          // The agent's hash stays, so a resent record is still recognised as a duplicate.
          contentHash: record.contentHash,
          payload: scrubText(stored.payload),
          observedAt,
          redactions: record.redactions,
          conversationKey,
        };
        if (previousRow === undefined) {
          note(record.provider, "accepted");
        } else {
          note(record.provider, "replaced");
          touch(record.provider, previousRow.conversationKey);
        }
        known.set(ref, row);
        pending.set(ref, row);
        pendingBlobs.set(ref, stored.blobs);
        touch(record.provider, conversationKey);
      }
      if (pending.size > 0) {
        const written = yield* tx
          .insert(sourceRecords)
          .values([...pending.values()])
          .onConflictDoUpdate({
            target: [sourceRecords.streamRef, sourceRecords.recordKey],
            set: {
              ...excluded(sourceRecords, [
                "contentHash",
                "payload",
                "observedAt",
                "redactions",
                "conversationKey",
              ]),
              ingestedAt: sql`now()`,
            },
            setWhere: sql`${sourceRecords.observedAt} <= excluded.observed_at`,
          })
          .returning({
            id: sourceRecords.id,
            streamRef: sourceRecords.streamRef,
            recordKey: sourceRecords.recordKey,
          });
        yield* setRecordBlobs(
          written.flatMap((row) => {
            const blobs = pendingBlobs.get(recordRef(row.streamRef, row.recordKey));
            return blobs === undefined ? [] : [{ id: row.id, blobs }];
          }),
        );
      }

      yield* markDirty([...dirty.values()]);
      yield* tx
        .update(ingestBatches)
        .set({ accepted, duplicates, replaced })
        .where(eq(ingestBatches.id, batch.batchId));
      const [machine] = yield* tx
        .update(machines)
        .set({ lastSeenAt: sql`now()`, agentVersion: batch.agentVersion })
        .where(eq(machines.id, machineId))
        .returning({ name: machines.name });
      return {
        result: { batchId: batch.batchId, accepted, duplicates, replaced } satisfies IngestResult,
        tally: { machine: machine?.name ?? machineId, entries: [...tally.values()] },
      };
    }),
  );
  // Counted after the commit, so a rolled-back batch or a replayed acknowledgement is never counted.
  if (outcome.tally !== null) {
    const { machine, entries } = outcome.tally;
    yield* Metric.update(Metric.withAttributes(batchesIngested, { machine }), 1);
    for (const entry of entries)
      yield* Metric.update(
        Metric.withAttributes(recordsIngested, {
          machine,
          provider: entry.provider,
          outcome: entry.outcome,
        }),
        entry.count,
      );
  }
  return outcome.result;
});

export const tombstonesSince = Effect.fn("Ingest.tombstonesSince")(function* (
  since: string | undefined,
) {
  const db = yield* Db;
  const rows = yield* db
    .select({
      provider: tombstones.provider,
      conversationKey: tombstones.conversationKey,
      deletedAt: tombstones.deletedAt,
    })
    .from(tombstones)
    // Replay the cursor millisecond so a deletion committed after the previous read is not lost.
    .where(since === undefined ? undefined : sql`${tombstones.deletedAt} >= ${since}::timestamptz`);
  return rows.map((row): Tombstone => ({
    provider: row.provider,
    conversationKey: ConversationKey.make(row.conversationKey),
    deletedAt: row.deletedAt.toISOString(),
  }));
});
