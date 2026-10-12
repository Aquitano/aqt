import type { Normalizer } from "@aqt/turnstash-core";
import { normalizers } from "@aqt/turnstash-providers";
import { sql } from "drizzle-orm";
import { ConfigProvider, Effect, Layer } from "effect";

import { ServerConfig, ServerConfigLive } from "../src/config.ts";
import { Db, DbLive, PgLive, runMigrations } from "../src/db/client.ts";
import { Normalizers, normalizersLayer } from "../src/registry.ts";
import { ensureBundledCatalog } from "../src/valuation.ts";

export const testDatabaseUrl =
  process.env["TEST_DATABASE_URL"] ??
  "postgres://turnstash:turnstash@localhost:5434/turnstash_test";

const ConfigTest = ServerConfigLive.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        DATABASE_URL: testDatabaseUrl,
        ADMIN_TOKEN: "admin-secret",
        PORT: "0",
        WORKER_INTERVAL_MS: "50",
      }),
    ),
  ),
);

export const TestLayer = (overrides: Partial<Record<keyof typeof normalizers, Normalizer>> = {}) =>
  Layer.mergeAll(DbLive, normalizersLayer({ ...normalizers, ...overrides })).pipe(
    Layer.provideMerge(PgLive),
    Layer.provideMerge(ConfigTest),
  );

export type TestServices = Db | Normalizers | ServerConfig;

const tables = [
  "bookmarks",
  "dashboard_sessions",
  "commit_links",
  "commits",
  "repository_paths",
  "conversation_turns",
  "valuations",
  "model_requests",
  "tool_executions",
  "messages",
  "conversation_machines",
  "conversations",
  "dirty_conversations",
  "source_records",
  "source_streams",
  "ingest_batches",
  "tombstones",
  "subscription_plans",
  "api_tokens",
  "machines",
  "pricing_catalogs",
  "pricing_rules",
];

export const resetDatabase = Effect.gen(function* () {
  if (!decodeURIComponent(new URL(testDatabaseUrl).pathname).endsWith("_test")) {
    return yield* Effect.die(
      "TEST_DATABASE_URL must name a database ending in _test; tests truncate its tables",
    );
  }
  yield* runMigrations();
  const db = yield* Db;
  yield* db.execute(sql.raw(`TRUNCATE ${tables.map((table) => `"${table}"`).join(", ")} CASCADE`));
  yield* ensureBundledCatalog();
});

export const runTest = <A, E>(
  effect: Effect.Effect<A, E, TestServices>,
  overrides?: Partial<Record<keyof typeof normalizers, Normalizer>>,
) =>
  Effect.runPromise(
    Effect.andThen(resetDatabase, effect).pipe(Effect.provide(TestLayer(overrides))),
  );
