import { createHmac } from "node:crypto";

import { BadRequest, type QueryInput, type QueryResult } from "@aqt/turnstash-api";
import { PgClient } from "@effect/sql-pg";
import { sql } from "drizzle-orm";
import { Effect, Redacted, Schema, Stream } from "effect";
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
// query leaves on its session, such as an advisory lock, outlives it. Postgres lets an owner that is not a
// superuser set the restricted attributes only when it creates the role, so later starts change only the login.
// Tracing stays off because the password is part of the statement text.
export const ensureReaderRole = Effect.fn("Query.ensureReaderRole")(function* () {
  const db = yield* Db;
  const config = yield* ServerConfig;
  const password = readerPassword(Redacted.value(config.databaseUrl));
  yield* db.execute(
    sql.raw(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${readerRole}') THEN
          CREATE ROLE ${readerRole} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`),
  );
  yield* db.execute(
    sql.raw(`ALTER ROLE ${readerRole} WITH LOGIN CONNECTION LIMIT 4 PASSWORD '${password}'`),
  );
  for (const grant of grantReader) yield* db.execute(sql.raw(grant));
}, Effect.withTracerEnabled(false));

const readerUrl = (databaseUrl: string) => {
  const url = new URL(databaseUrl);
  url.username = readerRole;
  url.password = readerPassword(databaseUrl);
  return Redacted.make(url.toString());
};

export const resultBudgetBytes = 16 * 1024 * 1024;

const tooLarge = new BadRequest({
  message: `The result is larger than ${resultBudgetBytes / 1024 / 1024} MB. Select fewer rows or columns, or aggregate in SQL.`,
});

const RawRow = Schema.Struct({
  columns: Schema.NullOr(Schema.String),
  cells: Schema.NullOr(Schema.String),
});
const decodeRawRow = Schema.decodeUnknownEffect(RawRow);
const decodeColumns = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const decodeCells = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Json)));

// A single row past the budget never reaches the stream: the driver refuses the protocol message that carries it.
const isOversizedRow = Schema.is(
  Schema.Struct({
    _tag: Schema.Literal("PgProtocolParseError"),
    message: Schema.String.check(Schema.isPattern(/exceeds maxMessageSize/)),
  }),
);

const PostgresMessage = Schema.Struct({ message: Schema.String, code: Schema.String });
const isPostgresMessage = Schema.is(PostgresMessage);

// Connection loss, exhausted resources, shutdowns and internal errors are the database failing to serve the
// query, not the query being wrong. A statement timeout is the query's own cost, so it is reported to the caller.
const unavailable = /^(08|53|57P|58|XX)/;

// Each row goes out as its values in column order, because a JSON object would silently keep only one of two
// columns with the same name, such as two sum() aggregates. A number a JavaScript double cannot hold exactly,
// such as a large numeric, goes out as its decimal string. The row after the limit only marks the result as
// truncated, so its values are never sent.
const cellsOf = (body: string, limit: number) => `
  SELECT CASE WHEN n = 1 THEN
           (SELECT json_agg(e.key ORDER BY e.n) FROM json_each(row) WITH ORDINALITY AS e(key, value, n))
         END::text AS columns,
         CASE WHEN n <= ${limit} THEN
           (SELECT json_agg(
              CASE WHEN json_typeof(e.value) <> 'number' THEN e.value
                   WHEN e.value::text::numeric <> 0
                        AND abs(e.value::text::numeric) NOT BETWEEN 1e-300 AND 1e300 THEN to_json(e.value::text)
                   WHEN e.value::text::numeric::float8::numeric = e.value::text::numeric THEN e.value
                   ELSE to_json(e.value::text) END
              ORDER BY e.n)
            FROM json_each(row) WITH ORDINALITY AS e(key, value, n))
         END::text AS cells
  FROM (
    SELECT to_json(q) AS row, row_number() OVER () AS n
    FROM (
${body}
    ) AS q LIMIT ${limit + 1}
  ) AS numbered`;

// The query is wrapped as a subquery so the row cap and the JSON encoding happen in Postgres, and the
// extended protocol the driver uses refuses a second statement smuggled past the closing parenthesis. Rows are
// streamed and counted, so a large result is refused before the server holds all of it.
export const runQuery = Effect.fn("Query.run")(
  function* (input: QueryInput) {
    const config = yield* ServerConfig;
    const limit = input.limit ?? 500;
    const client = yield* PgClient.make({
      url: readerUrl(Redacted.value(config.databaseUrl)),
      maxConnections: 1,
      maxMessageSize: resultBudgetBytes,
      applicationName: "turnstash-query",
      startupParameters: {
        statement_timeout: String(config.statementTimeoutMillis),
        default_transaction_read_only: "on",
        search_path: "analytics",
      },
    });
    const body = input.sql
      .trim()
      .replace(/;+\s*(?:--[^\n]*\s*)*$/, "")
      .trimEnd();
    const cells: Array<string> = [];
    let columns: string | null = null;
    let bytes = 0;
    let received = 0;
    yield* client.unsafe(cellsOf(body, limit)).stream.pipe(
      Stream.runForEach((raw) =>
        Effect.gen(function* () {
          const row = yield* decodeRawRow(raw).pipe(Effect.orDie);
          received += 1;
          if (row.cells === null) return;
          bytes += Buffer.byteLength(row.cells) + Buffer.byteLength(row.columns ?? "");
          if (bytes > resultBudgetBytes) yield* tooLarge;
          columns ??= row.columns;
          cells.push(row.cells);
        }),
      ),
    );
    return {
      columns: columns === null ? [] : yield* decodeColumns(columns).pipe(Effect.orDie),
      rows: yield* Effect.forEach(cells, (row) => decodeCells(row).pipe(Effect.orDie)),
      truncated: received > cells.length,
    } satisfies QueryResult;
  },
  Effect.scoped,
  Effect.provide(Reactivity.layer),
  Effect.catchTag("SqlError", (error): Effect.Effect<never, BadRequest | SqlError> => {
    const { cause } = error.reason;
    if (isOversizedRow(cause)) return Effect.fail(tooLarge);
    return error.reason.operation === "query" &&
      isPostgresMessage(cause) &&
      !unavailable.test(cause.code)
      ? Effect.fail(new BadRequest({ message: cause.message }))
      : Effect.fail(error);
  }),
);
