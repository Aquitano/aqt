import { expect, test } from "bun:test";

import { MachineAuth } from "@aqt/turnstash-api";
import { sha256Hex } from "@aqt/turnstash-core";
import { BunHttpServer } from "@effect/platform-bun";
import { eq, sql } from "drizzle-orm";
import {
  Cause,
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Result,
  Schema,
} from "effect";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { MachineAuthLive } from "../src/auth.ts";
import { ServerConfigLive } from "../src/config.ts";
import { Db, DbLive, inTransaction, PgLive } from "../src/db/client.ts";
import { failureSummary } from "../src/db/errors.ts";
import { machines } from "../src/db/schema.ts";
import { databaseFailure } from "../src/http-errors.ts";
import { runTest, testDatabaseUrl } from "./support.ts";

const database = (timeout: string) =>
  DbLive.pipe(
    Layer.provide(PgLive),
    Layer.provide(ServerConfigLive),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          DATABASE_URL: testDatabaseUrl,
          ADMIN_TOKEN: "test",
          DB_STATEMENT_TIMEOUT_MS: timeout,
        }),
      ),
    ),
  );

test("transaction helpers provide the transaction Db and roll back writes made through it", async () => {
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      const id = crypto.randomUUID();
      const result = yield* inTransaction(
        Effect.gen(function* () {
          const tx = yield* Db;
          expect(tx).not.toBe(db);
          yield* tx.insert(machines).values({
            id,
            name: "transaction-test",
            os: "linux",
            arch: "x64",
            tokenHash: sha256Hex(id),
          });
          return yield* Effect.fail("rollback");
        }),
      ).pipe(Effect.result);
      expect(result).toEqual(Result.fail("rollback"));
      expect(yield* db.select().from(machines).where(eq(machines.id, id))).toEqual([]);
    }),
  );
});

test("database deadlines cancel slow statements and leave connections usable", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      const result = yield* db.execute(sql`select pg_sleep(0.25)`).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(failureSummary(result.failure)).toMatchObject({
          reason: "StatementTimeoutError",
          sqlState: "57014",
          operation: "query",
        });
      const response = yield* db.execute(sql`select pg_sleep(0.25)`).pipe(databaseFailure);
      expect(response).toMatchObject({ status: 503 });
      const rows = yield* db.execute<{ timeout: string; value: number }>(
        sql`select current_setting('statement_timeout') as timeout, 1 as value`,
        "objects",
      );
      expect(rows).toEqual([{ timeout: "50ms", value: 1 }]);
    }).pipe(Effect.provide(database("50"))),
  );
});

test("database diagnostics exclude query text, parameters and server error detail", async () => {
  const logs: Array<string> = [];
  const sentinel = "private-transcript-marker";
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      const response = yield* db.execute(sql`select ${sentinel}::integer`).pipe(databaseFailure);
      expect(response).toMatchObject({ status: 500 });
    }).pipe(
      Effect.provide(database("30000")),
      Effect.provide(
        Logger.layer([Logger.make((options) => logs.push(Logger.formatJson.log(options)))]),
      ),
    ),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("22P02");
  expect(logs[0]).not.toContain(sentinel);
  expect(logs[0]).not.toContain("select");
  expect(failureSummary(Cause.die(new Error(sentinel)))).toEqual({ reason: "UnexpectedFailure" });
});

test("authentication timeouts return 503 without running the protected handler", async () => {
  const id = crypto.randomUUID();
  const token = "private-auth-timeout-token";
  let handled = false;
  const api = HttpApi.make("deadline").add(
    HttpApiGroup.make("protected")
      .add(HttpApiEndpoint.get("protected", "/protected", { success: Schema.String }))
      .middleware(MachineAuth),
  );
  const handlers = HttpApiBuilder.group(api, "protected", (routes) =>
    routes.handle("protected", () =>
      Effect.sync(() => {
        handled = true;
        return "ok";
      }),
    ),
  );
  const web = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(api).pipe(
      Layer.provide(handlers),
      Layer.provide(MachineAuthLive),
      Layer.provide(database("50")),
      Layer.provide(BunHttpServer.layerHttpServices),
    ),
  );
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.execute(
          sql`insert into machines (id, name, os, arch, token_hash) values (${id}, 'deadline-test', 'darwin', 'arm64', ${sha256Hex(token)})`,
        );
        yield* Effect.addFinalizer(() =>
          db.execute(sql`delete from machines where id = ${id}`).pipe(Effect.orDie),
        );
        const locked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holding = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.execute(sql`select id from machines where id = ${id} for update`);
              yield* Deferred.succeed(locked, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(locked);
        const response = yield* Effect.promise(() =>
          web.handler(
            new Request("http://test/protected", {
              headers: { Authorization: `Bearer ${token}` },
            }),
          ),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holding);
        expect(response.status).toBe(503);
        expect(handled).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(database("50"))),
    );
  } finally {
    await web.dispose();
  }
});
