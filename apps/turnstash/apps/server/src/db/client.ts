import { PgClient } from "@effect/sql-pg";
import { sql } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import type {
  EffectPgQueryEffectHKT,
  EffectPgQueryResultHKT,
} from "drizzle-orm/effect-postgres/session";
import type { PgEffectDatabase } from "drizzle-orm/pg-core/effect";
import { Context, Effect, Layer } from "effect";

import { ServerConfig } from "../config.ts";

export type Database = PgEffectDatabase<EffectPgQueryEffectHKT, EffectPgQueryResultHKT>;

export class Db extends Context.Service<Db, Database>()("@turnstash/Db") {}

export const PgLive = Layer.unwrap(
  Effect.map(ServerConfig, (config) =>
    PgClient.layer({
      url: config.databaseUrl,
      maxConnections: 10,
      startupParameters: { statement_timeout: String(config.statementTimeoutMillis) },
    }),
  ),
);

export const DbLive = Layer.effect(Db, PgDrizzle.makeWithDefaults());

export const migrationsFolder = new URL("../../drizzle", import.meta.url).pathname;

const migrationLock = 7_365_742_019;

// The migrator itself neither locks nor lifts the request deadline, so a server and a reprocess run starting
// together would both apply the same migration, and an index build on a large table would hit the timeout.
export const runMigrations = Effect.fn("Db.migrate")(function* () {
  const db = yield* PgDrizzle.makeWithDefaults();
  yield* db.transaction(() =>
    Effect.gen(function* () {
      yield* db.execute(sql`SET LOCAL statement_timeout = 0`);
      yield* db.execute(sql`SELECT pg_advisory_xact_lock(${migrationLock})`);
      // A new ParadeDB image only replaces the pg_search binary, and its SQL functions fail until the catalog
      // is updated to match.
      yield* db.execute(sql`
        DO $$ BEGIN
          IF EXISTS (SELECT FROM pg_extension e JOIN pg_available_extensions a ON a.name = e.extname
            WHERE e.extname = 'pg_search' AND e.extversion <> a.default_version) THEN
            ALTER EXTENSION pg_search UPDATE;
          END IF;
        END $$
      `);
      yield* migrate(db, { migrationsFolder });
    }),
  );
});

export const inTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Db, (db) => db.transaction((tx) => effect.pipe(Effect.provideService(Db, tx))));
