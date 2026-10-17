import { type ProviderId, providerIds, StreamId } from "@aqt/turnstash-core";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { Effect } from "effect";

import { Db, inTransaction } from "./db/client.ts";
import { sourceRecords, sourceStreams } from "./db/schema.ts";
import { Normalizers } from "./registry.ts";
import { queueArchive } from "./reprocess.ts";
import { scrubText } from "./scrub.ts";

const pageSize = 500;

export interface TrimmedProvider {
  readonly provider: ProviderId;
  readonly records: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

// Rows are rewritten in pages, each in its own transaction. A record replaced after it was read keeps
// the new version, because the update matches the hash that was read.
const trimProvider = Effect.fn("Archive.trimProvider")(function* (
  provider: ProviderId,
  trim: (streamId: StreamId, payload: string) => string,
) {
  const db = yield* Db;
  const totals = { provider, records: 0, bytesBefore: 0, bytesAfter: 0 };
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
      .limit(pageSize);
    const last = page.at(-1);
    if (last === undefined) return totals satisfies TrimmedProvider;
    after = last.id;
    const changed = page.flatMap((row) => {
      const payload = scrubText(trim(StreamId.make(row.streamId), row.payload));
      return payload === row.payload ? [] : [{ ...row, trimmed: payload }];
    });
    yield* inTransaction(
      Effect.gen(function* () {
        const tx = yield* Db;
        for (const row of changed)
          yield* tx
            .update(sourceRecords)
            .set({ payload: row.trimmed })
            .where(
              and(eq(sourceRecords.id, row.id), eq(sourceRecords.contentHash, row.contentHash)),
            );
      }),
    );
    for (const row of changed) {
      totals.records += 1;
      totals.bytesBefore += Buffer.byteLength(row.payload);
      totals.bytesAfter += Buffer.byteLength(row.trimmed);
    }
  }
});

// OpenCode left its JSON file store behind when it moved to SQLite. A file whose row the same
// machine's database holds is dropped, since normalize prefers the database row.
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
          )
        RETURNING 1
      )
      SELECT count(*)::integer AS count FROM removed
    `,
    "objects",
  );
  return removed[0]?.count ?? 0;
});

export const trimArchive = Effect.fn("Archive.trim")(function* () {
  const normalizers = yield* Normalizers;
  const trimmed: Array<TrimmedProvider> = [];
  for (const provider of providerIds) {
    const trim = normalizers[provider].trim;
    if (trim !== undefined) trimmed.push(yield* trimProvider(provider, trim));
  }
  // Both statements cover the whole archive and outlast the per-statement deadline.
  const { opencodeFileTwins, queued } = yield* inTransaction(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.execute(sql`SET LOCAL statement_timeout = 0`);
      return { opencodeFileTwins: yield* removeOpencodeFileTwins(), queued: yield* queueArchive() };
    }),
  );
  return { trimmed, opencodeFileTwins, queued };
});
