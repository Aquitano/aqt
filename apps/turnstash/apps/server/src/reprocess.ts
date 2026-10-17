import { type ProviderId, providerIds, StreamId } from "@aqt/turnstash-core";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { Effect } from "effect";

import { Db, inTransaction } from "./db/client.ts";
import { dirtyConversations, sourceRecords, sourceStreams, tombstones } from "./db/schema.ts";
import { Normalizers } from "./registry.ts";
import { scrubText } from "./scrub.ts";
import { ensureBundledCatalog, recalculateCatalogs } from "./valuation.ts";

const trimPageSize = 500;

// Records stored before their provider's trim existed are rewritten in pages, each in its own transaction.
// A record replaced after it was read keeps the new version, because the update matches the hash that was
// read.
const trimRecords = Effect.fn("Archive.trimRecords")(function* (
  provider: ProviderId,
  trim: (streamId: StreamId, payload: string) => string,
) {
  const db = yield* Db;
  let trimmed = 0;
  let after = 0;
  while (true) {
    const page = yield* db
      .select({
        id: sourceRecords.id,
        contentHash: sourceRecords.contentHash,
        payload: sourceRecords.payload,
        streamId: sourceStreams.streamId,
      })
      .from(sourceRecords)
      .innerJoin(sourceStreams, eq(sourceStreams.id, sourceRecords.streamRef))
      .where(and(eq(sourceRecords.provider, provider), gt(sourceRecords.id, after)))
      .orderBy(asc(sourceRecords.id))
      .limit(trimPageSize);
    const last = page.at(-1);
    if (last === undefined) return trimmed;
    after = last.id;
    const changed = page.flatMap(({ id, contentHash, payload, streamId }) => {
      const kept = scrubText(trim(StreamId.make(streamId), payload));
      return kept === payload ? [] : [{ id, contentHash, payload: kept }];
    });
    yield* inTransaction(
      Effect.gen(function* () {
        const tx = yield* Db;
        for (const row of changed)
          yield* tx
            .update(sourceRecords)
            .set({ payload: row.payload })
            .where(
              and(eq(sourceRecords.id, row.id), eq(sourceRecords.contentHash, row.contentHash)),
            );
      }),
    );
    trimmed += changed.length;
  }
});

// OpenCode left its JSON file store behind when it moved to SQLite. A file whose row the same machine's
// database sent is dropped, since normalize prefers the database row. Trimming runs first and turns every
// readable data column into an object, so a row whose data stayed text, or that jsonb cannot hold (an escaped
// NUL), keeps its file as the fallback. Only session rows normalize without a data column, and a row only stands
// in for a file of the same conversation.
const removeOpencodeFileTwins = Effect.fn("Archive.removeOpencodeFileTwins")(function* () {
  const db = yield* Db;
  const removed = yield* db.execute<{ count: number }>(
    sql`
      WITH removed AS (
        DELETE FROM ${sourceRecords} AS legacy
        USING ${sourceStreams} AS file
        WHERE legacy.stream_ref = file.id
          AND file.provider = 'opencode'
          AND file.stream_id ~ '/json/storage/(session|message|part)/'
          AND EXISTS (
            SELECT 1 FROM ${sourceStreams} AS database
            JOIN ${sourceRecords} AS twin ON twin.stream_ref = database.id
            WHERE database.machine_id = file.machine_id
              AND database.provider = 'opencode'
              AND database.stream_id ~ '/sqlite/'
              AND twin.record_key = substring(file.stream_id from '([^/]+)\\.json$')
              AND twin.conversation_key = legacy.conversation_key
              AND CASE WHEN twin.payload IS JSON OBJECT AND pg_input_is_valid(twin.payload, 'jsonb')
                THEN coalesce(
                  jsonb_typeof(twin.payload::jsonb -> 'data'),
                  CASE WHEN file.stream_id ~ '/json/storage/session/' THEN 'object' END
                ) = 'object'
                ELSE false END
          )
        RETURNING 1
      )
      SELECT count(*)::integer AS count FROM removed
    `,
    "objects",
  );
  return removed[0]?.count ?? 0;
});

// Marks every archived conversation dirty, so the worker rebuilds each one from its records.
const queueArchive = Effect.fn("Archive.queue")(function* () {
  const db = yield* Db;
  const queued = yield* db.execute<{ count: number }>(
    sql`
      WITH queued AS (
        INSERT INTO ${dirtyConversations} (provider, conversation_key, marked_at)
        SELECT DISTINCT provider, conversation_key, now()
        FROM ${sourceRecords} AS records
        WHERE conversation_key IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM ${tombstones} AS deleted
          WHERE deleted.provider = records.provider AND deleted.conversation_key = records.conversation_key
        )
        ON CONFLICT (provider, conversation_key) DO UPDATE SET marked_at = excluded.marked_at
        RETURNING 1
      )
      SELECT count(*)::integer AS count FROM queued
    `,
    "objects",
  );
  return queued[0]?.count ?? 0;
});

export const reprocessArchive = Effect.fn("Archive.reprocess")(function* () {
  const normalizers = yield* Normalizers;
  let trimmed = 0;
  for (const provider of providerIds) {
    const trim = normalizers[provider].trim;
    if (trim !== undefined) trimmed += yield* trimRecords(provider, trim);
  }
  return yield* inTransaction(
    Effect.gen(function* () {
      const db = yield* Db;
      // These statements cover the whole archive and outlast the per-statement deadline.
      yield* db.execute(sql`SET LOCAL statement_timeout = 0`);
      yield* ensureBundledCatalog();
      const catalogVersion = yield* recalculateCatalogs();
      const opencodeFileTwins = yield* removeOpencodeFileTwins();
      const queued = yield* queueArchive();
      return { trimmed, opencodeFileTwins, queued, catalogVersion };
    }),
  );
});
