import { sql } from "drizzle-orm";
import { Effect } from "effect";

import { Db, inTransaction } from "./db/client.ts";
import { dirtyConversations, sourceRecords, tombstones } from "./db/schema.ts";
import { ensureBundledCatalog, recalculateCatalogs } from "./valuation.ts";

// Marks every archived conversation dirty, so the worker rebuilds each one from its records.
export const queueArchive = Effect.fn("Archive.queue")(function* () {
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
  yield* ensureBundledCatalog();
  const catalogVersion = yield* recalculateCatalogs();
  const queued = yield* queueArchive();
  return { queued, catalogVersion };
}, inTransaction);
