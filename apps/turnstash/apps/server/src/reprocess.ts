import { type Normalizer, type ProviderId, providerIds, StreamId } from "@aqt/turnstash-core";
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";

import { deleteUnlinkedBlobs, setRecordBlobs } from "./blobs.ts";
import { lockConversations } from "./conversation-locks.ts";
import { Db, inTransaction } from "./db/client.ts";
import {
  dirtyConversations,
  recordSegments,
  sourceRecords,
  sourceStreams,
  tombstones,
} from "./db/schema.ts";
import { Normalizers, storedRecordOf } from "./registry.ts";
import { scrubText } from "./scrub.ts";
import { deleteUnreferencedSegments, packSegment, payloadsOf } from "./segments.ts";
import { ensureBundledCatalog, recalculateCatalogs } from "./valuation.ts";

const trimPageRows = 500;
const trimPageBytes = 32 * 1024 * 1024;

// A page holds at least one record and stops at whichever limit it reaches first, so records full of
// images are rewritten a few at a time.
const pageIdsOf = (rows: ReadonlyArray<{ readonly id: number; readonly bytes: number }>) => {
  const ids: Array<number> = [];
  let bytes = 0;
  for (const row of rows) {
    bytes += row.bytes;
    if (ids.length > 0 && bytes > trimPageBytes) break;
    ids.push(row.id);
  }
  return ids;
};

// Records stored in an older form are rewritten in pages, each in its own transaction. A record replaced
// after it was read keeps the new version, because the update matches the hash that was read.
const trimRecords = Effect.fn("Archive.trimRecords")(function* (
  provider: ProviderId,
  normalizer: Normalizer,
) {
  const db = yield* Db;
  let trimmed = 0;
  let after = 0;
  while (true) {
    const sizes = yield* db
      .select({ id: sourceRecords.id, bytes: sql<number>`octet_length(${sourceRecords.payload})` })
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.provider, provider),
          gt(sourceRecords.id, after),
          isNotNull(sourceRecords.payload),
        ),
      )
      .orderBy(asc(sourceRecords.id))
      .limit(trimPageRows);
    const ids = pageIdsOf(sizes);
    const last = ids.at(-1);
    if (last === undefined) return trimmed;
    after = last;
    const page = yield* db
      .select({
        id: sourceRecords.id,
        contentHash: sourceRecords.contentHash,
        payload: sql<string>`${sourceRecords.payload}`,
        streamId: sourceStreams.streamId,
      })
      .from(sourceRecords)
      .innerJoin(sourceStreams, eq(sourceStreams.id, sourceRecords.streamRef))
      .where(and(inArray(sourceRecords.id, ids), isNotNull(sourceRecords.payload)));
    const changed = page.flatMap(({ id, contentHash, payload, streamId }) => {
      const kept = storedRecordOf(normalizer, StreamId.make(streamId), payload);
      const keptPayload = scrubText(kept.payload);
      return keptPayload === payload
        ? []
        : [{ id, contentHash, payload: keptPayload, blobs: kept.blobs, sha256s: kept.sha256s }];
    });
    yield* inTransaction(
      Effect.gen(function* () {
        const tx = yield* Db;
        const rewritten = yield* Effect.filter(changed, (row) =>
          tx
            .update(sourceRecords)
            .set({ payload: row.payload })
            .where(
              and(
                eq(sourceRecords.id, row.id),
                eq(sourceRecords.contentHash, row.contentHash),
                isNull(sourceRecords.segmentRef),
              ),
            )
            .returning({ id: sourceRecords.id })
            .pipe(Effect.map((updated) => updated.length > 0)),
        );
        yield* setRecordBlobs(rewritten);
      }),
    );
    trimmed += changed.length;
  }
});

// A sealed record is trimmed inside its segment, which is packed again when a record changed or when it still
// holds records that were since replaced or deleted.
const trimSegment = Effect.fn("Archive.trimSegment")(function* (
  segment: Pick<typeof recordSegments.$inferSelect, "id" | "provider" | "conversationKey">,
  normalizer: Normalizer,
) {
  const db = yield* Db;
  yield* lockConversations([segment]);
  const rows = yield* db
    .select({
      id: sourceRecords.id,
      payload: sourceRecords.payload,
      segmentRef: sourceRecords.segmentRef,
      streamId: sourceStreams.streamId,
    })
    .from(sourceRecords)
    .innerJoin(sourceStreams, eq(sourceStreams.id, sourceRecords.streamRef))
    .where(eq(sourceRecords.segmentRef, segment.id))
    .orderBy(asc(sourceRecords.id))
    .for("update", { of: sourceRecords });
  if (rows.length === 0) return 0;
  const payloads = yield* payloadsOf(rows);
  const kept = rows.map((row) => {
    const payload = payloads.get(row.id) ?? "";
    const stored = storedRecordOf(normalizer, StreamId.make(row.streamId), payload);
    return { id: row.id, before: payload, ...stored, payload: scrubText(stored.payload) };
  });
  const changed = kept.filter((record) => record.payload !== record.before);
  const [stored] = yield* db
    .select({ records: recordSegments.records })
    .from(recordSegments)
    .where(eq(recordSegments.id, segment.id));
  if (changed.length === 0 && stored?.records === rows.length) return 0;
  yield* db
    .update(recordSegments)
    .set({
      data: yield* packSegment(kept.map((record) => [record.id, record.payload])),
      records: rows.length,
    })
    .where(eq(recordSegments.id, segment.id));
  yield* setRecordBlobs(changed);
  return changed.length;
}, inTransaction);

const trimSegments = Effect.fn("Archive.trimSegments")(function* (
  provider: ProviderId,
  normalizer: Normalizer,
) {
  const db = yield* Db;
  const segments = yield* db
    .select({
      id: recordSegments.id,
      provider: recordSegments.provider,
      conversationKey: recordSegments.conversationKey,
    })
    .from(recordSegments)
    .where(eq(recordSegments.provider, provider))
    .orderBy(asc(recordSegments.id));
  let trimmed = 0;
  for (const segment of segments) trimmed += yield* trimSegment(segment, normalizer);
  return trimmed;
});

// OpenCode left its JSON file store behind when it moved to SQLite. A file whose row the same machine's
// database sent is dropped, since normalize prefers the database row. Trimming runs first and turns every
// readable data column into an object, so a row whose data stayed text, or that jsonb cannot hold (an escaped
// NUL), keeps its file as the fallback, and so does a row that is already sealed. Only session rows normalize without a data column, and a row only stands
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
  yield* deleteUnreferencedSegments();
  for (const provider of providerIds) {
    trimmed += yield* trimRecords(provider, normalizers[provider]);
    trimmed += yield* trimSegments(provider, normalizers[provider]);
  }
  return yield* inTransaction(
    Effect.gen(function* () {
      const db = yield* Db;
      // These statements cover the whole archive and outlast the per-statement deadline.
      yield* db.execute(sql`SET LOCAL statement_timeout = 0`);
      yield* ensureBundledCatalog();
      const catalogVersion = yield* recalculateCatalogs();
      const opencodeFileTwins = yield* removeOpencodeFileTwins();
      yield* deleteUnlinkedBlobs();
      const queued = yield* queueArchive();
      return { trimmed, opencodeFileTwins, queued, catalogVersion };
    }),
  );
});
