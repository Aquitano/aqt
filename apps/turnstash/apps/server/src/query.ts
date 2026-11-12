import { createHmac } from "node:crypto";

import { BadRequest, type QueryInput, type QueryResult } from "@aqt/turnstash-api";
import { PgClient } from "@effect/sql-pg";
import { sql } from "drizzle-orm";
import { Effect, Redacted, Schema } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import type { SqlError } from "effect/sql/SqlError";

import { ServerConfig } from "./config.ts";
import { grantReader, readerRole } from "./db/analytics.ts";
import { Db } from "./db/client.ts";

// Derived from the owner's connection URL, so every server process on the database agrees on it without
// another secret to configure, and it is only as guessable as the owner's own password.
const readerPassword = (databaseUrl: string) =>
  createHmac("sha256", databaseUrl).update(readerRole).digest("hex");

// Queries run as their own login role rather than through SET ROLE, which a query could undo with set_config.
// The role can read the analytics views and nothing else, and each query gets a fresh connection, so nothing a
// query leaves on its session, such as an advisory lock, outlives it.
export const ensureReaderRole = Effect.fn("Query.ensureReaderRole")(function* () {
  const db = yield* Db;
  const config = yield* ServerConfig;
  const password = readerPassword(Redacted.value(config.databaseUrl));
  yield* db.execute(
    sql.raw(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${readerRole}') THEN CREATE ROLE ${readerRole}; END IF;
    END $$`),
  );
  yield* db.execute(
    sql.raw(
      `ALTER ROLE ${readerRole} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4 PASSWORD '${password}'`,
    ),
  );
  for (const grant of grantReader) yield* db.execute(sql.raw(grant));
});

const readerUrl = (databaseUrl: string) => {
  const url = new URL(databaseUrl);
  url.username = readerRole;
  url.password = readerPassword(databaseUrl);
  return Redacted.make(url.toString());
};

const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ row: Schema.Record(Schema.String, Schema.Json) })),
);

const PostgresMessage = Schema.Struct({ message: Schema.String, code: Schema.String });
const isPostgresMessage = Schema.is(PostgresMessage);

// The query is wrapped as a subquery so the row cap and the JSON encoding happen in Postgres, and the
// extended protocol the driver uses refuses a second statement smuggled past the closing parenthesis.
export const runQuery = Effect.fn("Query.run")(
  function* (input: QueryInput) {
    const config = yield* ServerConfig;
    const limit = input.limit ?? 500;
    const client = yield* PgClient.make({
      url: readerUrl(Redacted.value(config.databaseUrl)),
      maxConnections: 1,
      applicationName: "turnstash-query",
      startupParameters: {
        statement_timeout: String(config.statementTimeoutMillis),
        default_transaction_read_only: "on",
        search_path: "analytics",
      },
    });
    const body = input.sql.trim().replace(/;+$/, "").trimEnd();
    const rows = yield* client.unsafe(
      `SELECT to_json(q) AS row FROM (\n${body}\n) AS q LIMIT ${limit + 1}`,
    );
    const decoded = yield* decodeRows(rows).pipe(Effect.orDie);
    return {
      rows: decoded.slice(0, limit).map(({ row }) => row),
      truncated: decoded.length > limit,
    } satisfies QueryResult;
  },
  Effect.scoped,
  Effect.provide(Reactivity.layer),
  // An error Postgres raised while running the query is the query's fault, so its message goes back to the
  // caller. Failing to connect stays a server failure.
  Effect.catchTag("SqlError", (error): Effect.Effect<never, BadRequest | SqlError> =>
    error.reason.operation === "query" && isPostgresMessage(error.reason.cause)
      ? Effect.fail(new BadRequest({ message: error.reason.cause.message }))
      : Effect.fail(error),
  ),
);
