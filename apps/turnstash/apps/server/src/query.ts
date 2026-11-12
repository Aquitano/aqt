import { createHmac } from "node:crypto";

import { BadRequest, type QueryInput, type QueryResult } from "@aqt/turnstash-api";
import { PgClient } from "@effect/sql-pg";
import { sql } from "drizzle-orm";
import { Effect, Redacted, Schema, Stream } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import type { SqlError } from "effect/sql/SqlError";

import { ServerConfig } from "./config.ts";
import { grantReader, readerRole, viewNames } from "./db/analytics.ts";
import { Db } from "./db/client.ts";

// Derived from the owner's connection URL, so every server process on the database agrees on it without
// another secret to configure, and it is only as guessable as the owner's own password.
const readerPassword = (databaseUrl: string) =>
  createHmac("sha256", databaseUrl).update(readerRole).digest("hex");

export class UnsafeReaderRole extends Schema.TaggedError<UnsafeReaderRole>()(
  "UnsafeReaderRole",
  {},
) {
  override get message() {
    return `${readerRole} has privileges beyond reading the analytics views, so its login is turned off`;
  }
}

// A role of this name that existed before the server created it, or that someone granted more since, could hold
// any privilege, and every query would run with it. It keeps a login only when it has no administrative
// attribute or membership, owns nothing, cannot create in the database, and has no access to any table or column
// beyond the analytics views and what every role has, such as reading PostGIS's spatial_ref_sys or updating
// pg_settings. The catalog counts too, because a grant on pg_authid would expose password hashes. It also may
// not run a SECURITY DEFINER function, which would read with its owner's privileges, other than pg_search's own
// index bookkeeping, as the bank app's query role also allows.
const restrictedCheck = `
  SELECT NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
     AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
     AND NOT has_database_privilege(r.oid, current_database(), 'CREATE')
     AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid)
     AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
                       AND NOT (n.nspname = 'analytics' AND c.relname IN (${viewNames.map((name) => `'${name}'`).join(", ")}))
                       AND EXISTS (
                         SELECT 1 FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(privilege)
                         WHERE CASE WHEN p.privilege IN ('DELETE', 'TRUNCATE')
                                 THEN has_table_privilege(r.oid, c.oid, p.privilege)
                                      AND NOT has_table_privilege('public', c.oid, p.privilege)
                                 ELSE EXISTS (
                                   SELECT 1 FROM pg_attribute a
                                   WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                                     AND has_column_privilege(r.oid, c.oid, a.attnum, p.privilege)
                                     AND NOT has_column_privilege('public', c.oid, a.attnum, p.privilege)) END))
     AND NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.prosecdef AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
                       AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
                                       WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                                         AND d.refclassid = 'pg_extension'::regclass AND d.deptype = 'e'
                                         AND e.extname = 'pg_search'))
     AND NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.pronamespace = 'pg_catalog'::regnamespace
                       AND p.proname IN ('pg_read_file', 'pg_read_binary_file', 'pg_stat_file', 'pg_ls_dir',
                                         'lo_import', 'lo_export')
                       AND has_function_privilege(r.oid, p.oid, 'EXECUTE')) AS restricted
  FROM pg_roles r WHERE r.rolname = '${readerRole}'`;

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
  // The login is off until the check passes, so a check that fails or errors leaves the endpoint closed.
  yield* db.execute(sql.raw(`ALTER ROLE ${readerRole} WITH NOLOGIN`));
  const [role] = yield* db.execute<{ restricted: boolean }>(sql.raw(restrictedCheck), "objects");
  if (role?.restricted !== true) yield* new UnsafeReaderRole();
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

// Numbers nested in an array or JSON value are passed through as Postgres wrote them.
const unrepresentable = new BadRequest({
  message:
    "The result holds a number JavaScript cannot represent inside an array or JSON value. Cast it to text.",
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
// columns with the same name, such as two sum() aggregates. A column's number goes out as a JSON number only
// when a JavaScript double holds it exactly: a safe integer, or a fraction of at most 15 digits. Any other goes
// out as its decimal string. Numbers nested in an array or JSON value keep Postgres's text and may round. The row after the limit only marks the result as
// truncated, so its values are never sent.
const cellsOf = (body: string, limit: number) => `
  SELECT CASE WHEN n = 1 THEN
           (SELECT json_agg(e.key ORDER BY e.n) FROM json_each(row) WITH ORDINALITY AS e(key, value, n))
         END::text AS columns,
         CASE WHEN n <= ${limit} THEN
           (SELECT json_agg(
              CASE WHEN json_typeof(e.value) <> 'number' THEN e.value
                   WHEN abs(e.value::text::numeric) <= 9007199254740991
                        AND (e.value::text::numeric = trunc(e.value::text::numeric)
                             OR length(regexp_replace(e.value::text, '[^0-9]', '', 'g')) <= 15) THEN e.value
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

// A "$" or an "e" inside a word, such as total$usd$ or time'12:00', is part of that word, not a quote or prefix.
const identifierChar = /[\p{L}\p{N}_$]/u;
const dollarQuote = /\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/uy;
const lineBreak = /[\r\n]/g;

// The end of a quoted literal or identifier that opens at start. E'' strings also escape with a backslash.
const closingQuote = (text: string, start: number, quote: string, backslashEscapes: boolean) => {
  let index = start + 1;
  while (index < text.length) {
    if (backslashEscapes && text[index] === "\\") index += 2;
    else if (text[index] === quote && text[index + 1] === quote) index += 2;
    else if (text[index] === quote) return index + 1;
    else index += 1;
  }
  return text.length;
};

const blockCommentEnd = (text: string, start: number) => {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    if (text.startsWith("/*", index)) {
      depth += 1;
      index += 2;
    } else if (text.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
    } else index += 1;
  }
  return text.length;
};

// A query file usually ends with ";", often followed by a comment, which cannot stay inside the subquery. One
// pass over the text skips literals, quoted identifiers, dollar-quoted bodies and comments, so a ";" inside
// them is kept, and blanks only the semicolons that no other code follows.
export const withoutFinalTerminators = (text: string) => {
  let terminators: Array<number> = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (text.startsWith("--", index)) {
      lineBreak.lastIndex = index;
      index = lineBreak.exec(text)?.index ?? text.length;
    } else if (text.startsWith("/*", index)) index = blockCommentEnd(text, index);
    else if (/\s/.test(char)) index += 1;
    else if (char === ";") {
      terminators.push(index);
      index += 1;
    } else {
      terminators = [];
      dollarQuote.lastIndex = index;
      const afterWord = identifierChar.test(text[index - 1] ?? "");
      const tag = char === "$" && !afterWord ? dollarQuote.exec(text)?.[0] : undefined;
      if (tag !== undefined) {
        const close = text.indexOf(tag, index + tag.length);
        index = close < 0 ? text.length : close + tag.length;
      } else if (char === "'" || char === '"')
        index = closingQuote(
          text,
          index,
          char,
          char === "'" &&
            /[eE]/.test(text[index - 1] ?? "") &&
            !identifierChar.test(text[index - 2] ?? ""),
        );
      else index += 1;
    }
  }
  let blanked = "";
  let from = 0;
  for (const position of terminators) {
    blanked += `${text.slice(from, position)} `;
    from = position + 1;
  }
  return blanked + text.slice(from);
};

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
    const body = withoutFinalTerminators(input.sql);
    const cells: Array<string> = [];
    let columns: string | null = null;
    let bytes = 0;
    let received = 0;
    // The LIMIT sits in SQL the caller's text could get around, such as with a UNION, so the stream stops too.
    yield* client.unsafe(cellsOf(body, limit)).stream.pipe(
      Stream.take(limit + 1),
      Stream.runForEach((raw) =>
        Effect.gen(function* () {
          const row = yield* decodeRawRow(raw).pipe(Effect.orDie);
          received += 1;
          if (row.cells === null || cells.length === limit) return;
          bytes += Buffer.byteLength(row.cells) + Buffer.byteLength(row.columns ?? "");
          if (bytes > resultBudgetBytes) yield* tooLarge;
          columns ??= row.columns;
          cells.push(row.cells);
        }),
      ),
    );
    return {
      columns: columns === null ? [] : yield* decodeColumns(columns).pipe(Effect.orDie),
      rows: yield* Effect.forEach(cells, (row) =>
        decodeCells(row).pipe(Effect.mapError(() => unrepresentable)),
      ),
      truncated: received > cells.length,
    } satisfies QueryResult;
  },
  Effect.scoped,
  Effect.provide(Reactivity.layer),
  // The statement text is the caller's query, which can hold pasted transcript text or secrets.
  Effect.withTracerEnabled(false),
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
