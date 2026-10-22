import { NotFound } from "@aqt/turnstash-api";
import { eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import { Db } from "./db/client.ts";
import { blobs, recordBlobs } from "./db/schema.ts";

const blobLockNamespace = 7_365_743;

const lockBlobs = Effect.fn("Blobs.lock")(function* (sha256s: ReadonlyArray<string>) {
  if (sha256s.length === 0) return;
  const db = yield* Db;
  yield* db.execute(sql`
    SELECT pg_advisory_xact_lock(${blobLockNamespace}, lock_key)
    FROM (
      SELECT DISTINCT hashtext(value) AS lock_key
      FROM unnest(${sql.param(sha256s)}::text[]) AS value
      ORDER BY lock_key
    ) AS locks`);
});

// Links each record to exactly the files it holds, storing a file only once. A replaced record can drop a
// file that nothing else links to, so those files are deleted.
export const setRecordBlobs = Effect.fn("Blobs.setForRecords")(function* (
  records: ReadonlyArray<{
    readonly id: number;
    readonly blobs: ReadonlyMap<string, Buffer>;
    readonly sha256s: ReadonlySet<string>;
  }>,
) {
  if (records.length === 0) return;
  const db = yield* Db;
  const recordIds = records.map((record) => record.id);
  const unlinked = yield* db
    .select({ sha256: recordBlobs.sha256 })
    .from(recordBlobs)
    .where(inArray(recordBlobs.recordId, recordIds));
  const files = new Map(records.flatMap((record) => [...record.blobs]));
  const requested = [...new Set(records.flatMap((record) => [...record.sha256s]))];
  yield* lockBlobs([...files.keys(), ...requested, ...unlinked.map((row) => row.sha256)]);
  yield* db.delete(recordBlobs).where(inArray(recordBlobs.recordId, recordIds));
  if (files.size > 0)
    yield* db
      .insert(blobs)
      .values([...files].map(([sha256, data]) => ({ sha256, data })))
      .onConflictDoNothing();
  const available = new Set(
    requested.length === 0
      ? []
      : (yield* db
          .select({ sha256: blobs.sha256 })
          .from(blobs)
          .where(inArray(blobs.sha256, requested))).map((row) => row.sha256),
  );
  const links = records.flatMap((record) =>
    [...record.sha256s]
      .filter((sha256) => available.has(sha256))
      .map((sha256) => ({ recordId: record.id, sha256 })),
  );
  if (links.length > 0) yield* db.insert(recordBlobs).values(links);
  if (unlinked.length > 0)
    yield* db.execute(
      sql`DELETE FROM ${blobs} WHERE ${inArray(blobs.sha256, [...new Set(unlinked.map((row) => row.sha256))])} AND NOT EXISTS (SELECT 1 FROM ${recordBlobs} WHERE ${recordBlobs.sha256} = ${blobs.sha256})`,
    );
});

export const deleteUnlinkedBlobs = Effect.fn("Blobs.deleteUnlinked")(function* () {
  const db = yield* Db;
  const candidates = yield* db
    .select({ sha256: blobs.sha256 })
    .from(blobs)
    .where(
      sql`NOT EXISTS (SELECT 1 FROM ${recordBlobs} WHERE ${recordBlobs.sha256} = ${blobs.sha256})`,
    );
  if (candidates.length === 0) return;
  const sha256s = candidates.map((row) => row.sha256);
  yield* lockBlobs(sha256s);
  // Recheck in a fresh statement snapshot after any concurrent link transaction has committed.
  yield* db.execute(
    sql`DELETE FROM ${blobs} WHERE ${blobs.sha256} = ANY(${sql.param(sha256s)}::text[]) AND NOT EXISTS (SELECT 1 FROM ${recordBlobs} WHERE ${recordBlobs.sha256} = ${blobs.sha256})`,
  );
});

export const getBlob = Effect.fn("Blobs.get")(function* (sha256: string) {
  const db = yield* Db;
  const [row] = yield* db
    .select({ data: blobs.data })
    .from(blobs)
    .where(eq(blobs.sha256, sha256))
    .limit(1);
  if (row === undefined) return yield* new NotFound({ entity: "blob", id: sha256 });
  return row.data;
});
