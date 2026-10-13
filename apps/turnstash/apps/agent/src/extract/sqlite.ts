import {
  encodedJsonBytes,
  RecordKey,
  type RawRecord,
  type SqliteTableSource,
  type StreamId,
} from "@aqt/turnstash-core";
import { Effect, Schema } from "effect";

import { openSqlite, type SqliteRow, sqliteOperation } from "../sqlite.ts";
import { type ExtractionLimits, extractionLimits, type SkippedRecord } from "./limits.ts";

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;
export const SqliteKey = Schema.Union([Schema.String, Schema.Finite, Schema.BigInt]);
export type SqliteKey = typeof SqliteKey.Type;

export interface SqlitePage {
  readonly records: ReadonlyArray<RawRecord>;
  readonly skipped: ReadonlyArray<SkippedRecord>;
  readonly nextKey: SqliteKey | null;
}

const canonicalJson = (row: SqliteRow): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.keys(row)
        .sort()
        .map((key) => {
          const value = row[key];
          return [key, value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value];
        }),
    ),
  );

export const extractSqliteTable = Effect.fn("Extract.sqliteTable")(function* (
  streamId: StreamId,
  absolutePath: string,
  source: SqliteTableSource,
  options: Partial<ExtractionLimits> & { readonly after?: SqliteKey } = {},
) {
  const limits = yield* extractionLimits(options);
  const db = yield* openSqlite(absolutePath, { readonly: true });
  // Providers name every table a tool has used across its versions, so each database lacks some.
  const exists = yield* sqliteOperation(
    "tableExists",
    absolutePath,
    () =>
      db
        .query(
          "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? COLLATE NOCASE",
        )
        .get(source.table) !== null,
  );
  if (!exists) return { records: [], skipped: [], nextKey: null } satisfies SqlitePage;
  const keyColumn = quoteIdentifier(source.keyColumn);
  const predicates = [`${keyColumn} IS NOT NULL`];
  if (source.where !== undefined) predicates.push(`(${source.where})`);
  if (options.after !== undefined) predicates.push(`${keyColumn} > $after`);
  const sql = `SELECT * FROM ${quoteIdentifier(source.table)} WHERE ${predicates.join(" AND ")} ORDER BY ${keyColumn} LIMIT $limit`;
  return yield* sqliteOperation("extractTable", absolutePath, () => {
    const rows = db.query<SqliteRow, { $limit: number; $after?: SqliteKey }>(sql).iterate({
      $limit: limits.maxRecords + 1,
      ...(options.after === undefined ? {} : { $after: options.after }),
    });
    const records: Array<RawRecord> = [];
    const skipped: Array<SkippedRecord> = [];
    let bytes = 0;
    let lastKey: SqliteKey | null = null;
    let visited = 0;
    let hasMore = false;
    for (const row of rows) {
      visited += 1;
      const key = Schema.decodeUnknownSync(SqliteKey)(row[source.keyColumn]);
      const record = {
        streamId,
        recordKey: RecordKey.make(String(key)),
        payload: canonicalJson(row),
      };
      const recordBytes = encodedJsonBytes(record);
      // A row larger than the limit can never be sent; paging past it keeps later rows flowing.
      if (recordBytes > limits.maxBytes) {
        skipped.push({ recordKey: record.recordKey, bytes: recordBytes });
        lastKey = key;
        continue;
      }
      if (records.length === limits.maxRecords || bytes + recordBytes > limits.maxBytes) {
        hasMore = true;
        break;
      }
      records.push(record);
      bytes += recordBytes;
      lastKey = key;
    }
    if (visited > limits.maxRecords) hasMore = true;
    return { records, skipped, nextKey: hasMore ? lastKey : null } satisfies SqlitePage;
  });
}, Effect.scoped);
