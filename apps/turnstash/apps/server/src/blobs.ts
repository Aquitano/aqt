import { NotFound } from "@aqt/turnstash-api";
import { eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import { Db } from "./db/client.ts";
import { blobs, recordBlobs } from "./db/schema.ts";

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
  const unlinked = yield* db
    .delete(recordBlobs)
    .where(
      inArray(
        recordBlobs.recordId,
        records.map((record) => record.id),
      ),
    )
    .returning({ sha256: recordBlobs.sha256 });
  const files = new Map(records.flatMap((record) => [...record.blobs]));
  if (files.size > 0)
    yield* db
      .insert(blobs)
      .values([...files].map(([sha256, data]) => ({ sha256, data })))
      .onConflictDoNothing();
  const requested = [...new Set(records.flatMap((record) => [...record.sha256s]))];
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
  yield* db.execute(
    sql`DELETE FROM ${blobs} WHERE NOT EXISTS (SELECT 1 FROM ${recordBlobs} WHERE ${recordBlobs.sha256} = ${blobs.sha256})`,
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
