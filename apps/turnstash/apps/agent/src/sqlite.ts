import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

import { Effect, Schema } from "effect";

export type SqliteRow = Record<string, string | number | bigint | Uint8Array | null>;

export class SqliteError extends Schema.TaggedError<SqliteError>()("SqliteError", {
  operation: Schema.String,
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

// Row decoding runs inside transactions so a bad row rolls the transaction back; its SchemaError
// keeps its own tag instead of being reported as a database failure.
export const sqliteOperation = <A>(operation: string, path: string, body: () => A) =>
  Effect.try({
    try: body,
    catch: (cause) =>
      Schema.isSchemaError(cause) ? cause : new SqliteError({ operation, path, cause }),
  });

// The agent state is shared by a scheduled sync and a manual one, and source databases are written
// by the running tool, so a locked database is waited on instead of failing at once.
const busyTimeoutMillis = 5000;

export const openSqlite = Effect.fn("Sqlite.open")(function* (
  path: string,
  options: { readonly readonly: boolean },
) {
  if (!options.readonly && path !== ":memory:") {
    yield* sqliteOperation("permissions", path, () => {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      closeSync(openSync(path, "a", 0o600));
      for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
        if (existsSync(file)) chmodSync(file, 0o600);
      }
    });
  }
  return yield* Effect.acquireRelease(
    sqliteOperation("open", path, () => {
      const db = new Database(path, options.readonly ? { readonly: true } : { create: true });
      db.exec(`PRAGMA busy_timeout = ${busyTimeoutMillis}`);
      return db;
    }),
    (db) => sqliteOperation("close", path, () => db.close()).pipe(Effect.orDie),
  );
});
