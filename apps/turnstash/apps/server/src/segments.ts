import { promisify } from "node:util";
import { constants, zstdCompress, zstdDecompress } from "node:zlib";

import type { ProviderId } from "@aqt/turnstash-core";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { lockConversations } from "./conversation-locks.ts";
import { Db, inTransaction } from "./db/client.ts";
import { dirtyConversations, recordSegments, sourceRecords } from "./db/schema.ts";

const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);

// Level 9 packs transcripts about a tenth tighter than the default for a sixth of its speed, which a record
// written once and read rarely can afford. Higher levels gain under 2% more.
const compression = { params: { [constants.ZSTD_c_compressionLevel]: 9 } };

// A long session is split so that one segment is unpacked at a time.
const segmentChars = 32 * 1024 * 1024;

export type SegmentEntry = readonly [recordId: number, payload: string];

const decodeEntries = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.Number, Schema.String]))),
);

const unpackSegment = (data: Buffer) =>
  Effect.promise(() => decompress(data)).pipe(
    Effect.flatMap((json) => decodeEntries(json.toString("utf8"))),
    Effect.orDie,
  );

// Whoever packs a segment then drops or overwrites the only other copy of its records, and raw records cannot
// be rebuilt, so the segment is read back before it is handed out.
export const packSegment = Effect.fn("Segments.pack")(function* (
  entries: ReadonlyArray<SegmentEntry>,
) {
  const data = yield* Effect.promise(() => compress(JSON.stringify(entries), compression));
  const stored = yield* unpackSegment(data);
  const intact =
    stored.length === entries.length &&
    stored.every(([id, payload], index) => {
      const entry = entries[index];
      return entry !== undefined && entry[0] === id && entry[1] === payload;
    });
  if (!intact) return yield* Effect.die("a packed segment does not read back as its records");
  return data;
});

export interface StoredRecord {
  readonly id: number;
  readonly payload: string | null;
  readonly segmentRef: number | null;
}

const recordIds = (ids: ReadonlyArray<number>) => sql`${sql.param(ids)}::bigint[]`;

// The payload of each record, read from its row or from the segment its row points at. A segment can still
// hold a record that was since replaced or deleted, and that entry is ignored.
export const payloadsOf = Effect.fn("Segments.payloadsOf")(function* (
  records: ReadonlyArray<StoredRecord>,
) {
  const db = yield* Db;
  const payloads = new Map<number, string>();
  const sealed = new Map<number, Set<number>>();
  for (const record of records) {
    if (record.payload !== null) payloads.set(record.id, record.payload);
    else if (record.segmentRef !== null)
      sealed.set(record.segmentRef, (sealed.get(record.segmentRef) ?? new Set()).add(record.id));
  }
  for (const [segmentId, wanted] of sealed) {
    const [segment] = yield* db
      .select({ data: recordSegments.data })
      .from(recordSegments)
      .where(eq(recordSegments.id, segmentId));
    if (segment === undefined) return yield* Effect.die(`record segment ${segmentId} is missing`);
    for (const [id, payload] of yield* unpackSegment(segment.data))
      if (wanted.has(id)) payloads.set(id, payload);
  }
  const missing = records.find((record) => !payloads.has(record.id));
  if (missing !== undefined)
    return yield* Effect.die(`record ${missing.id} has no payload in its segment`);
  return payloads;
});

const chunksOf = (rows: ReadonlyArray<{ readonly id: number; readonly payload: string }>) => {
  const chunks: Array<Array<SegmentEntry>> = [];
  let chars = 0;
  for (const row of rows) {
    const last = chunks.at(-1);
    if (last === undefined || chars + row.payload.length > segmentChars) {
      chunks.push([[row.id, row.payload]]);
      chars = row.payload.length;
    } else {
      last.push([row.id, row.payload]);
      chars += row.payload.length;
    }
  }
  return chunks;
};

// The rows are locked as they are read. Ingest locks the conversation a record arrives in, which is another
// one when a replaced record moves, and its upsert then waits here instead of being overwritten by the seal.
export const sealConversation = Effect.fn("Segments.sealConversation")(function* (
  provider: ProviderId,
  conversationKey: string,
) {
  const db = yield* Db;
  yield* lockConversations([{ provider, conversationKey }]);
  const rows = yield* db
    .select({ id: sourceRecords.id, payload: sql<string>`${sourceRecords.payload}` })
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.provider, provider),
        eq(sourceRecords.conversationKey, conversationKey),
        isNotNull(sourceRecords.payload),
      ),
    )
    .orderBy(asc(sourceRecords.id))
    .for("update");
  for (const entries of chunksOf(rows)) {
    const [segment] = yield* db
      .insert(recordSegments)
      .values({
        provider,
        conversationKey,
        data: yield* packSegment(entries),
        records: entries.length,
      })
      .returning({ id: recordSegments.id });
    if (segment === undefined) return yield* Effect.die("segment insert returned no row");
    yield* db
      .update(sourceRecords)
      .set({ payload: null, segmentRef: segment.id })
      .where(sql`${sourceRecords.id} = ANY(${recordIds(entries.map(([id]) => id))})`);
  }
  return rows.length;
}, inTransaction);

// Seals conversations whose every unsealed record arrived at least this long ago. One waiting to be
// normalized is left alone, because normalizing is about to read it. The idle ones are listed once: the
// listing reads every unsealed record, which is the whole archive the first time.
export const sealIdle = Effect.fn("Segments.sealIdle")(function* (idleDays: number) {
  const db = yield* Db;
  const idle = yield* db
    .select({ provider: sourceRecords.provider, conversationKey: sourceRecords.conversationKey })
    .from(sourceRecords)
    .where(
      and(
        isNotNull(sourceRecords.payload),
        isNotNull(sourceRecords.conversationKey),
        sql`NOT EXISTS (
          SELECT 1 FROM ${dirtyConversations}
          WHERE ${dirtyConversations.provider} = ${sourceRecords.provider}
            AND ${dirtyConversations.conversationKey} = ${sourceRecords.conversationKey})`,
      ),
    )
    .groupBy(sourceRecords.provider, sourceRecords.conversationKey)
    .having(sql`max(${sourceRecords.ingestedAt}) <= now() - make_interval(days => ${idleDays})`);
  let records = 0;
  for (const { provider, conversationKey } of idle)
    if (conversationKey !== null) records += yield* sealConversation(provider, conversationKey);
  return { conversations: idle.length, records };
});

export const deleteConversationSegments = Effect.fn("Segments.deleteForConversation")(function* (
  provider: ProviderId,
  conversationKey: string,
) {
  const db = yield* Db;
  yield* db
    .delete(recordSegments)
    .where(
      and(
        eq(recordSegments.provider, provider),
        eq(recordSegments.conversationKey, conversationKey),
      ),
    );
});

// A segment whose records were all replaced or deleted holds nothing a row still points at.
export const deleteUnreferencedSegments = Effect.fn("Segments.deleteUnreferenced")(function* () {
  const db = yield* Db;
  const deleted = yield* db
    .delete(recordSegments)
    .where(
      sql`NOT EXISTS (SELECT 1 FROM ${sourceRecords} WHERE ${sourceRecords.segmentRef} = ${recordSegments.id})`,
    )
    .returning({ id: recordSegments.id });
  return deleted.length;
});
